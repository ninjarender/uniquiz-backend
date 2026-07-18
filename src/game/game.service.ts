import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { ChainableCommander } from 'ioredis';
import { Prisma } from '../../generated/prisma/client';
import { AnswerSetStatus, GameMode } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameError } from './game-error';
import { JoinRoomDto } from './dto/join-room.dto';
import { RejoinRoomDto } from './dto/rejoin-room.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

/** Player as seen by clients (common.yaml Player). */
export interface PlayerView {
  id: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
}

/** Leaderboard row (common.yaml LeaderboardEntry); intermediate and final. */
export interface LeaderboardEntry {
  nickname: string;
  totalScore: number;
  correctAnswers: number;
  avgResponseMs?: number;
}

/**
 * RoomState snapshot: lobby in waiting; in in_game also the current question
 * with the time left and the intermediate leaderboard; in finished - the
 * final leaderboard.
 */
export interface RoomState {
  roomId: string;
  status: string;
  settings: {
    mode: string;
    questionCount: number;
    timePerQuestionSeconds: number;
  };
  bankName: string;
  players: PlayerView[];
  currentQuestion?: ActiveQuestionPayload & { remainingSeconds: number };
  leaderboard?: LeaderboardEntry[];
}

/** join_ack payload plus the broadcast-ready player entry. */
export interface JoinResult {
  playerId: string;
  resumeToken: string;
  room: RoomState;
  player: PlayerView;
}

/** Server-side player record in room:{roomId}:players (resumeToken stays here). */
interface StoredPlayer {
  nickname: string;
  isHost: boolean;
  connected: boolean;
  resumeToken: string;
  /** Join order for host succession (host_changed); ms timestamp. */
  joinedAt: number;
}

/** host_changed broadcast (asyncapi PlayerRefPayload). */
export interface PlayerRefPayload {
  playerId: string;
}

/** What the gateway broadcasts after a socket drops. */
export interface DisconnectResult {
  roomId: string;
  playerId: string;
  hostChanged?: PlayerRefPayload;
}

/** game_started broadcast (asyncapi GameStartedPayload). */
export interface GameStartedPayload {
  gameId: string;
  questionCount: number;
  timePerQuestionSeconds: number;
  players: PlayerView[];
}

/** question_started broadcast (asyncapi ActiveQuestion, player-safe). */
export interface ActiveQuestionPayload {
  gameId: string;
  index: number;
  text: string;
  options: string[];
  imageUrl?: string;
  timeLimitSeconds: number;
  questionStartTime: number;
}

/** What the gateway broadcasts to the room after a successful start. */
export interface StartGameResult {
  roomId: string;
  gameStarted: GameStartedPayload;
  questionStarted: ActiveQuestionPayload;
}

/** submit_answer_ack payload (asyncapi SubmitAnswerAck). */
export interface SubmitAnswerAck {
  accepted: boolean;
  questionIndex: number;
}

/**
 * Server-side answer record in game:{gameId}:answers:{index} (data-model.md).
 * score/isCorrect are computed at fixation from the server clock and never
 * sent to the player before round_result.
 */
interface StoredAnswer {
  /** null - no answer for the whole round ("без відповіді"). */
  selectedOptionIndex: number | null;
  isSubmitted: boolean;
  answerTime: number;
  elapsedMs: number;
  score: number;
  isCorrect: boolean;
  auto: boolean;
}

/** Round closure notification for the round_result flow (task 0038). */
export interface RoundClosedInfo {
  gameId: string;
  roomId: string;
  questionIndex: number;
}

/**
 * Personal slice of round_result (asyncapi PersonalRoundResult). The correct
 * option is deliberately absent - any reveal would expose the trap round.
 */
export interface PersonalRoundResult {
  selectedOptionIndex: number | null;
  isCorrect: boolean;
  score: number;
  /** null - "no answer" for the whole round. */
  elapsedMs: number | null;
  totalScore: number;
}

/** Everything the gateway needs to deliver round_result personally. */
export interface RoundResultData {
  roomId: string;
  gameId: string;
  questionIndex: number;
  /** true - game_over follows instead of the next question. */
  isLast: boolean;
  leaderboard: LeaderboardEntry[];
  perPlayer: Record<string, PersonalRoundResult>;
}

/** Running totals of one player across the game's rounds. */
interface PlayerTotals {
  totalScore: number;
  correctAnswers: number;
  responseTimes: number[];
}

/**
 * Server-side question snapshot in game:{gameId}:questions (data-model.md).
 * correctIndex/isTrap never leave the server during the game.
 */
interface GameQuestionSnapshot {
  index: number;
  baseQuestionId: string;
  text: string;
  options: string[];
  correctIndex: number | null;
  isTrap: boolean;
  imageUrl?: string;
  /** Revealed only in the game_over review. */
  explanation?: string;
}

/** Per-question reveal in the final review (asyncapi QuestionReview). */
export interface QuestionReview {
  index: number;
  text: string;
  options: string[];
  /** null - the trap question (no correct option exists). */
  correctIndex: number | null;
  isTrap: boolean;
  explanation?: string;
}

/** game_over broadcast (asyncapi GameOverPayload). */
export interface GameOverPayload {
  gameId: string;
  leaderboard: LeaderboardEntry[];
  trapQuestionIndex: number;
  review: QuestionReview[];
}

/** Answer-set statuses that make a question playable (accepted/edited). */
const READY_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

/** Both room keys live 24h without activity (data-model.md); joins refresh it. */
const ROOM_TTL_SECONDS = 24 * 60 * 60;

/**
 * Grace window after T for auto-submissions still in flight (the client
 * auto-sends the last chosen option exactly at the timeout). The server
 * round timer fires at T + grace; manual submits are rejected after T.
 */
const ROUND_GRACE_MS = 1500;

/** Leaderboard pause between round_result and the next question (value TBD). */
const ROUND_RESULT_PAUSE_MS = 5000;

/** Game snapshot lives ~1h after the game_results insert (data-model.md). */
const GAME_REVIEW_TTL_SECONDS = 60 * 60;

@Injectable()
export class GameService implements OnModuleDestroy {
  /** In-process round timers per gameId (single-instance MVP). */
  private readonly roundTimers = new Map<string, NodeJS.Timeout>();

  /** Set by the gateway: personal round_result delivery to each player. */
  onRoundResult?: (data: RoundResultData) => void;

  /** Set by the gateway: question_started broadcast for the next round. */
  onQuestionStarted?: (roomId: string, question: ActiveQuestionPayload) => void;

  /** Set by the gateway: game_over broadcast with the full reveal. */
  onGameOver?: (roomId: string, payload: GameOverPayload) => void;

  /** Set by the gateway: settings_updated broadcast to the lobby. */
  onSettingsUpdated?: (roomId: string, settings: RoomState['settings']) => void;

  /**
   * Bridge for the REST layer (PATCH /rooms/{roomId}, task 0020): a successful
   * settings update is announced to the lobby as settings_updated.
   */
  notifySettingsUpdated(roomId: string, settings: RoomState['settings']): void {
    this.onSettingsUpdated?.(roomId, settings);
  }

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.roundTimers.values()) {
      clearTimeout(timer);
    }
    this.roundTimers.clear();
  }

  /**
   * join_room: only into a waiting room, nickname unique per room
   * (business-rules.md), hostToken match makes the player the host.
   * Throws GameError with an asyncapi error code otherwise.
   */
  async joinRoom(payload: JoinRoomDto): Promise<JoinResult> {
    const roomKey = `room:${payload.roomId}`;
    const playersKey = `${roomKey}:players`;

    const room = await this.redis.client.hgetall(roomKey);
    if (Object.keys(room).length === 0) {
      throw new GameError('room_not_found', 'Room not found');
    }
    if (room.status !== 'waiting') {
      throw new GameError(
        'room_not_waiting',
        'New players can join only while the room is waiting',
      );
    }

    const players = await this.loadPlayers(playersKey);
    if (
      Object.values(players).some(
        (player) => player.nickname === payload.nickname,
      )
    ) {
      throw new GameError(
        'nickname_taken',
        'This nickname is already taken in the room',
      );
    }

    const playerId = randomUUID();
    // A valid hostToken grants the host role only while the room has no host:
    // after a host_changed transfer the returning creator is a regular player.
    const roomHasHost = Object.values(players).some((player) => player.isHost);
    const stored: StoredPlayer = {
      nickname: payload.nickname,
      isHost:
        !roomHasHost &&
        payload.hostToken !== undefined &&
        payload.hostToken === room.hostToken,
      connected: true,
      resumeToken: randomBytes(24).toString('base64url'),
      joinedAt: Date.now(),
    };
    await this.redis.client
      .multi()
      .hset(playersKey, playerId, JSON.stringify(stored))
      .expire(roomKey, ROOM_TTL_SECONDS)
      .expire(playersKey, ROOM_TTL_SECONDS)
      .exec();

    const player = this.toView(playerId, stored);
    return {
      playerId,
      resumeToken: stored.resumeToken,
      room: this.toRoomState(payload.roomId, room, {
        ...players,
        [playerId]: stored,
      }),
      player,
    };
  }

  /**
   * rejoin_room: recognized by playerId + resumeToken at any stage
   * (business-rules.md). Marks the player connected and returns the full
   * room_state snapshot; in in_game it includes the current question with
   * remainingSeconds so the client can pick up the round mid-flight.
   */
  async rejoinRoom(
    payload: RejoinRoomDto,
  ): Promise<{ room: RoomState; player: PlayerView }> {
    const roomKey = `room:${payload.roomId}`;
    const playersKey = `${roomKey}:players`;

    const room = await this.redis.client.hgetall(roomKey);
    if (Object.keys(room).length === 0) {
      throw new GameError('room_not_found', 'Room not found');
    }

    const players = await this.loadPlayers(playersKey);
    const stored = players[payload.playerId];
    // Unknown playerId and wrong token are the same error - no membership probing.
    if (!stored || stored.resumeToken !== payload.resumeToken) {
      throw new GameError('invalid_resume_token', 'Invalid resume credentials');
    }

    stored.connected = true;
    await this.redis.client
      .multi()
      .hset(playersKey, payload.playerId, JSON.stringify(stored))
      .expire(roomKey, ROOM_TTL_SECONDS)
      .expire(playersKey, ROOM_TTL_SECONDS)
      .exec();

    const state = this.toRoomState(payload.roomId, room, players);
    if (room.gameId && room.status === 'in_game') {
      const currentQuestion = await this.loadCurrentQuestion(
        room.gameId,
        Number(room.timePerQuestionSeconds),
      );
      if (currentQuestion) {
        state.currentQuestion = currentQuestion;
      }
    }
    if (room.gameId && room.status !== 'waiting') {
      // in_game - intermediate leaderboard, finished - final one.
      state.leaderboard = await this.buildLeaderboard(room.gameId, players);
    }
    return { room: state, player: this.toView(payload.playerId, stored) };
  }

  /**
   * Leaderboard from the game's answer records (business-rules.md totals):
   * totalScore is the rounded sum, correctAnswers includes the trap rule,
   * avgResponseMs covers non-trap questions only. Round-close records for
   * silent players (task 0038) slot in through the same aggregation. Also
   * the building block for round_result/game_over (0038/0039).
   */
  private async buildLeaderboard(
    gameId: string,
    players: Record<string, StoredPlayer>,
  ): Promise<LeaderboardEntry[]> {
    return this.leaderboardFromTotals(
      players,
      await this.aggregateTotals(gameId, players),
    );
  }

  /** Per-player running totals across all answered rounds of the game. */
  private async aggregateTotals(
    gameId: string,
    players: Record<string, StoredPlayer>,
  ): Promise<Map<string, PlayerTotals>> {
    const questionsRaw = await this.redis.client.hgetall(
      `game:${gameId}:questions`,
    );
    const trapByIndex = new Map(
      Object.entries(questionsRaw).map(([index, json]) => [
        index,
        (JSON.parse(json) as GameQuestionSnapshot).isTrap,
      ]),
    );
    const answersByIndex = await Promise.all(
      [...trapByIndex.keys()].map(async (index) => ({
        index,
        answers: await this.redis.client.hgetall(
          `game:${gameId}:answers:${index}`,
        ),
      })),
    );

    const totals = new Map<string, PlayerTotals>();
    for (const playerId of Object.keys(players)) {
      totals.set(playerId, {
        totalScore: 0,
        correctAnswers: 0,
        responseTimes: [],
      });
    }
    for (const { index, answers } of answersByIndex) {
      for (const [playerId, json] of Object.entries(answers)) {
        const answer = JSON.parse(json) as StoredAnswer;
        const total = totals.get(playerId);
        if (!total) {
          continue;
        }
        total.totalScore += answer.score;
        total.correctAnswers += answer.isCorrect ? 1 : 0;
        if (!trapByIndex.get(index)) {
          total.responseTimes.push(answer.elapsedMs);
        }
      }
    }
    return totals;
  }

  private leaderboardFromTotals(
    players: Record<string, StoredPlayer>,
    totals: Map<string, PlayerTotals>,
  ): LeaderboardEntry[] {
    return [...totals.entries()]
      .map(([playerId, total]) => ({
        nickname: players[playerId].nickname,
        totalScore: Math.round(total.totalScore),
        correctAnswers: total.correctAnswers,
        ...(total.responseTimes.length > 0 && {
          avgResponseMs: Math.round(
            total.responseTimes.reduce((sum, ms) => sum + ms, 0) /
              total.responseTimes.length,
          ),
        }),
      }))
      .sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * Socket drop: marks the player offline; when the host drops, the role
   * moves to the earliest-joined connected player (realtime-protocol.md) -
   * the old host does not get it back on return. Returns what to broadcast,
   * or null when the socket had no live room membership.
   */
  async handleDisconnect(session: {
    roomId?: string;
    playerId?: string;
  }): Promise<DisconnectResult | null> {
    const { roomId, playerId } = session;
    if (!roomId || !playerId) {
      return null;
    }
    const playersKey = `room:${roomId}:players`;
    const players = await this.loadPlayers(playersKey);
    const stored = players[playerId];
    if (!stored) {
      return null;
    }

    stored.connected = false;
    const multi = this.redis.client
      .multi()
      .hset(playersKey, playerId, JSON.stringify(stored));

    let hostChanged: PlayerRefPayload | undefined;
    if (stored.isHost) {
      const successorId = this.transferHost(
        multi,
        playersKey,
        players,
        playerId,
      );
      if (successorId) {
        stored.isHost = false;
        multi.hset(playersKey, playerId, JSON.stringify(stored));
        hostChanged = { playerId: successorId };
      }
    }
    await multi.exec();

    return { roomId, playerId, ...(hostChanged && { hostChanged }) };
  }

  /**
   * leave_room: lobby-only (business-rules.md - joining and leaving are
   * waiting-stage actions; mid-game drops are disconnects, not leaves).
   * Removes the player; a leaving host hands the role over per the
   * host_changed rule. Returns the broadcasts for the remaining players.
   */
  async leaveRoom(session: { roomId?: string; playerId?: string }): Promise<{
    roomId: string;
    playerLeft: PlayerRefPayload;
    hostChanged?: PlayerRefPayload;
  }> {
    const { roomId, playerId } = session;
    if (!roomId || !playerId) {
      throw new GameError('not_a_member', 'Join a room first');
    }
    const roomKey = `room:${roomId}`;
    const playersKey = `${roomKey}:players`;

    const room = await this.redis.client.hgetall(roomKey);
    if (Object.keys(room).length === 0) {
      throw new GameError('room_not_found', 'Room not found');
    }
    if (room.status !== 'waiting') {
      throw new GameError(
        'room_not_waiting',
        'Leaving is a lobby action; a running game treats drops as disconnects',
      );
    }

    const players = await this.loadPlayers(playersKey);
    const stored = players[playerId];
    if (!stored) {
      throw new GameError('not_a_member', 'You are not in this room');
    }

    const multi = this.redis.client
      .multi()
      .hdel(playersKey, playerId)
      .expire(roomKey, ROOM_TTL_SECONDS)
      .expire(playersKey, ROOM_TTL_SECONDS);

    let hostChanged: PlayerRefPayload | undefined;
    if (stored.isHost) {
      const successorId = this.transferHost(
        multi,
        playersKey,
        players,
        playerId,
      );
      if (successorId) {
        hostChanged = { playerId: successorId };
      }
    }
    await multi.exec();

    return {
      roomId,
      playerLeft: { playerId },
      ...(hostChanged && { hostChanged }),
    };
  }

  /**
   * Queues the host handover to the earliest-joined connected player other
   * than excludeId (realtime-protocol.md); returns the successor id or null.
   */
  private transferHost(
    multi: ChainableCommander,
    playersKey: string,
    players: Record<string, StoredPlayer>,
    excludeId: string,
  ): string | null {
    const successor = Object.entries(players)
      .filter(([id, player]) => id !== excludeId && player.connected)
      .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)[0];
    if (!successor) {
      return null;
    }
    const [successorId, successorStored] = successor;
    successorStored.isHost = true;
    multi.hset(playersKey, successorId, JSON.stringify(successorStored));
    return successorId;
  }

  /**
   * submit_answer: fixes the player's answer with server-side time and score
   * (business-rules.md). A confirmed answer is final - repeats are answered
   * with accepted=false; a closed/timed-out round is a question_finished
   * error. When every player of the room has submitted, the round is marked
   * closed early (round_result broadcast - task 0038).
   */
  async submitAnswer(
    session: { roomId?: string; playerId?: string },
    payload: SubmitAnswerDto,
  ): Promise<{ ack: SubmitAnswerAck; roomId: string; allSubmitted: boolean }> {
    const { roomId, playerId } = session;
    if (!roomId || !playerId) {
      throw new GameError('not_a_member', 'Join a room first');
    }

    const room = await this.redis.client.hgetall(`room:${roomId}`);
    if (Object.keys(room).length === 0) {
      throw new GameError('room_not_found', 'Room not found');
    }
    if (room.gameId !== payload.gameId) {
      throw new GameError('invalid_payload', 'Unknown game for this room');
    }
    if (room.status !== 'in_game') {
      throw new GameError('question_finished', 'The game is not running');
    }

    const stateKey = `game:${payload.gameId}:state`;
    const state = await this.redis.client.hgetall(stateKey);
    const questionStartTime = Number(state.questionStartTime);
    const timeLimitMs = Number(room.timePerQuestionSeconds) * 1000;
    const answerTime = Date.now();
    const elapsedMs = answerTime - questionStartTime;
    // Manual submits die at T; auto-submits (sent by the client exactly at
    // the timeout) get the grace window and are scored as taken at T.
    const lateLimitMs = payload.auto
      ? timeLimitMs + ROUND_GRACE_MS
      : timeLimitMs;
    if (
      state.roundStatus !== 'question_active' ||
      payload.questionIndex !== Number(state.currentIndex) ||
      elapsedMs > lateLimitMs
    ) {
      throw new GameError('question_finished', 'This round is already over');
    }
    const scoredElapsedMs = Math.min(elapsedMs, timeLimitMs);

    const answersKey = `game:${payload.gameId}:answers:${payload.questionIndex}`;
    const existing = await this.redis.client.hget(answersKey, playerId);
    if (existing) {
      // A confirmed answer is final; repeats and changes are ignored.
      return {
        ack: { accepted: false, questionIndex: payload.questionIndex },
        roomId,
        allSubmitted: false,
      };
    }

    const rawQuestion = await this.redis.client.hget(
      `game:${payload.gameId}:questions`,
      String(payload.questionIndex),
    );
    if (!rawQuestion) {
      throw new GameError('question_finished', 'This round is already over');
    }
    const question = JSON.parse(rawQuestion) as GameQuestionSnapshot;

    // Trap: any chosen option scores 0 (the 500 for staying silent is granted
    // at round close - task 0038). Normal: exact 500 - 30/s, no rounding.
    const isCorrect =
      !question.isTrap && payload.selectedOptionIndex === question.correctIndex;
    const score = isCorrect
      ? Math.max(500 - (30 * scoredElapsedMs) / 1000, 0)
      : 0;
    const stored: StoredAnswer = {
      selectedOptionIndex: payload.selectedOptionIndex,
      isSubmitted: true,
      answerTime,
      elapsedMs: scoredElapsedMs,
      score,
      isCorrect,
      auto: payload.auto ?? false,
    };
    await this.redis.client
      .multi()
      .hset(answersKey, playerId, JSON.stringify(stored))
      .expire(answersKey, ROOM_TTL_SECONDS)
      .exec();

    const [players, submittedCount] = await Promise.all([
      this.redis.client.hlen(`room:${roomId}:players`),
      this.redis.client.hlen(answersKey),
    ]);
    const allSubmitted = submittedCount >= players;
    if (allSubmitted) {
      await this.closeRound(payload.gameId, roomId);
    }

    return {
      ack: { accepted: true, questionIndex: payload.questionIndex },
      roomId,
      allSubmitted,
    };
  }

  /**
   * Closes the current round: idempotent flip to round_result, cancels the
   * timer, records "no answer" for silent players (normal - 0, trap - 500
   * and correct, per business-rules.md), hands the personal results and the
   * leaderboard to the gateway, and schedules the next step after the pause
   * (next question, or game_over - task 0039).
   */
  async closeRound(
    gameId: string,
    roomId: string,
  ): Promise<RoundClosedInfo | null> {
    const stateKey = `game:${gameId}:state`;
    const state = await this.redis.client.hgetall(stateKey);
    if (state.roundStatus !== 'question_active') {
      return null;
    }
    this.clearRoundTimer(gameId);
    await this.redis.client.hset(stateKey, 'roundStatus', 'round_result');

    const questionIndex = Number(state.currentIndex);
    const answersKey = `game:${gameId}:answers:${questionIndex}`;
    const [players, answered, rawQuestion, roomFields] = await Promise.all([
      this.loadPlayers(`room:${roomId}:players`),
      this.redis.client.hgetall(answersKey),
      this.redis.client.hget(`game:${gameId}:questions`, state.currentIndex),
      this.redis.client.hmget(
        `room:${roomId}`,
        'timePerQuestionSeconds',
        'questionCount',
      ),
    ]);
    const isTrap = rawQuestion
      ? (JSON.parse(rawQuestion) as GameQuestionSnapshot).isTrap
      : false;
    const silent: StoredAnswer = {
      selectedOptionIndex: null,
      isSubmitted: false,
      answerTime: Date.now(),
      elapsedMs: Number(roomFields[0]) * 1000,
      score: isTrap ? 500 : 0,
      isCorrect: isTrap,
      auto: false,
    };
    const missing = Object.keys(players).filter(
      (playerId) => !answered[playerId],
    );
    if (missing.length > 0) {
      const multi = this.redis.client.multi();
      for (const playerId of missing) {
        multi.hset(answersKey, playerId, JSON.stringify(silent));
        answered[playerId] = JSON.stringify(silent);
      }
      multi.expire(answersKey, ROOM_TTL_SECONDS);
      await multi.exec();
    }

    // Totals are aggregated after the silent records land, so the round's
    // leaderboard already reflects everyone.
    const totals = await this.aggregateTotals(gameId, players);
    const perPlayer: Record<string, PersonalRoundResult> = {};
    for (const playerId of Object.keys(players)) {
      const raw = answered[playerId];
      if (!raw) {
        continue;
      }
      const answer = JSON.parse(raw) as StoredAnswer;
      perPlayer[playerId] = {
        selectedOptionIndex: answer.selectedOptionIndex,
        isCorrect: answer.isCorrect,
        score: Math.round(answer.score),
        elapsedMs: answer.isSubmitted ? answer.elapsedMs : null,
        totalScore: Math.round(totals.get(playerId)?.totalScore ?? 0),
      };
    }

    const isLast = questionIndex >= Number(roomFields[1]) - 1;
    this.onRoundResult?.({
      roomId,
      gameId,
      questionIndex,
      isLast,
      leaderboard: this.leaderboardFromTotals(players, totals),
      perPlayer,
    });
    this.schedulePauseThenAdvance(gameId, roomId, isLast);
    return { gameId, roomId, questionIndex };
  }

  /**
   * After the leaderboard pause: the next question (new questionStartTime,
   * fresh timer, question_started via the gateway) or the game_over flow.
   */
  async advanceRound(gameId: string, roomId: string): Promise<void> {
    const stateKey = `game:${gameId}:state`;
    const state = await this.redis.client.hgetall(stateKey);
    if (state.roundStatus !== 'round_result') {
      return;
    }
    const nextIndex = Number(state.currentIndex) + 1;
    const raw = await this.redis.client.hget(
      `game:${gameId}:questions`,
      String(nextIndex),
    );
    if (!raw) {
      return;
    }
    const questionStartTime = Date.now();
    await this.redis.client
      .multi()
      .hset(stateKey, {
        currentIndex: nextIndex,
        questionStartTime,
        roundStatus: 'question_active',
      })
      .expire(stateKey, ROOM_TTL_SECONDS)
      .exec();

    const timeLimitSeconds = Number(
      await this.redis.client.hget(`room:${roomId}`, 'timePerQuestionSeconds'),
    );
    this.scheduleRoundTimer(gameId, roomId, timeLimitSeconds);
    const question = JSON.parse(raw) as GameQuestionSnapshot;
    this.onQuestionStarted?.(roomId, {
      gameId,
      index: question.index,
      text: question.text,
      options: question.options,
      ...(question.imageUrl !== undefined && { imageUrl: question.imageUrl }),
      timeLimitSeconds,
      questionStartTime,
    });
  }

  /**
   * game_over: full reveal (correct answers, explanations, the trap) plus the
   * final leaderboard; one INSERT into game_results for the host's history;
   * room flips to finished and the game snapshot gets a ~1h TTL so the final
   * screen survives rejoin (data-model.md). Idempotent via the room status.
   */
  async finishGame(
    gameId: string,
    roomId: string,
  ): Promise<GameOverPayload | null> {
    const roomKey = `room:${roomId}`;
    const room = await this.redis.client.hgetall(roomKey);
    if (room.status !== 'in_game' || room.gameId !== gameId) {
      return null;
    }

    const players = await this.loadPlayers(`${roomKey}:players`);
    const totals = await this.aggregateTotals(gameId, players);
    const leaderboard = this.leaderboardFromTotals(players, totals);

    const questionsRaw = await this.redis.client.hgetall(
      `game:${gameId}:questions`,
    );
    const review: QuestionReview[] = Object.values(questionsRaw)
      .map((json) => JSON.parse(json) as GameQuestionSnapshot)
      .sort((a, b) => a.index - b.index)
      .map((question) => ({
        index: question.index,
        text: question.text,
        options: question.options,
        correctIndex: question.correctIndex,
        isTrap: question.isTrap,
        ...(question.explanation !== undefined && {
          explanation: question.explanation,
        }),
      }));
    const trapQuestionIndex =
      review.find((question) => question.isTrap)?.index ?? -1;

    await this.prisma.gameResult.create({
      data: {
        userId: room.userId,
        bankId: room.bankId,
        mode: room.mode as GameMode,
        questionCount: Number(room.questionCount),
        finishedAt: new Date(),
        leaderboard: leaderboard as unknown as Prisma.InputJsonValue,
      },
    });

    const multi = this.redis.client
      .multi()
      .hset(roomKey, 'status', 'finished')
      .expire(`game:${gameId}:state`, GAME_REVIEW_TTL_SECONDS)
      .expire(`game:${gameId}:questions`, GAME_REVIEW_TTL_SECONDS);
    for (const index of Object.keys(questionsRaw)) {
      multi.expire(`game:${gameId}:answers:${index}`, GAME_REVIEW_TTL_SECONDS);
    }
    await multi.exec();

    const payload: GameOverPayload = {
      gameId,
      leaderboard,
      trapQuestionIndex,
      review,
    };
    this.onGameOver?.(roomId, payload);
    return payload;
  }

  /** Leaderboard pause, then the next question or the game_over hook. */
  private schedulePauseThenAdvance(
    gameId: string,
    roomId: string,
    isLast: boolean,
  ): void {
    this.clearRoundTimer(gameId);
    const timer = setTimeout(() => {
      this.roundTimers.delete(gameId);
      if (isLast) {
        void this.finishGame(gameId, roomId).catch(() => undefined);
        return;
      }
      void this.advanceRound(gameId, roomId).catch(() => undefined);
    }, ROUND_RESULT_PAUSE_MS);
    this.roundTimers.set(gameId, timer);
  }

  /** Arms the round timer: fires at T + grace and closes the round. */
  private scheduleRoundTimer(
    gameId: string,
    roomId: string,
    timeLimitSeconds: number,
  ): void {
    this.clearRoundTimer(gameId);
    const timer = setTimeout(
      () => {
        this.roundTimers.delete(gameId);
        void this.closeRound(gameId, roomId).catch(() => undefined);
      },
      timeLimitSeconds * 1000 + ROUND_GRACE_MS,
    );
    this.roundTimers.set(gameId, timer);
  }

  private clearRoundTimer(gameId: string): void {
    const timer = this.roundTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.roundTimers.delete(gameId);
    }
  }

  /** Player-safe ActiveQuestion of the running game, with the time left. */
  private async loadCurrentQuestion(
    gameId: string,
    timeLimitSeconds: number,
  ): Promise<(ActiveQuestionPayload & { remainingSeconds: number }) | null> {
    const state = await this.redis.client.hgetall(`game:${gameId}:state`);
    if (Object.keys(state).length === 0) {
      return null;
    }
    const raw = await this.redis.client.hget(
      `game:${gameId}:questions`,
      state.currentIndex,
    );
    if (!raw) {
      return null;
    }
    const question = JSON.parse(raw) as GameQuestionSnapshot;
    const questionStartTime = Number(state.questionStartTime);
    const elapsedSeconds = (Date.now() - questionStartTime) / 1000;
    return {
      gameId,
      index: question.index,
      text: question.text,
      options: question.options,
      ...(question.imageUrl !== undefined && { imageUrl: question.imageUrl }),
      timeLimitSeconds,
      questionStartTime,
      remainingSeconds: Math.max(0, timeLimitSeconds - elapsedSeconds),
    };
  }

  /**
   * start_game: host-only, waiting-only. Start conditions (business-rules.md):
   * Solo — exactly 1 player, Multiplayer — 2+, and the bank still has at least
   * questionCount accepted/edited answer sets. Builds the game snapshot in
   * Redis (random pick, shuffled options, one trap question), flips the room
   * to in_game and returns the payloads the gateway broadcasts.
   */
  async startGame(session: {
    roomId?: string;
    playerId?: string;
  }): Promise<StartGameResult> {
    const { roomId, playerId } = session;
    if (!roomId || !playerId) {
      throw new GameError('not_a_member', 'Join a room first');
    }
    const roomKey = `room:${roomId}`;
    const playersKey = `${roomKey}:players`;

    const room = await this.redis.client.hgetall(roomKey);
    if (Object.keys(room).length === 0) {
      throw new GameError('room_not_found', 'Room not found');
    }
    if (room.status !== 'waiting') {
      throw new GameError(
        'room_not_waiting',
        'The game can start only from the waiting state',
      );
    }

    const players = await this.loadPlayers(playersKey);
    const me = players[playerId];
    if (!me) {
      throw new GameError('not_a_member', 'You are not in this room');
    }
    if (!me.isHost) {
      throw new GameError('not_host', 'Only the host can start the game');
    }

    const playerCount = Object.keys(players).length;
    if (room.mode === 'solo' ? playerCount !== 1 : playerCount < 2) {
      throw new GameError(
        'start_conditions_not_met',
        room.mode === 'solo'
          ? 'Solo mode needs exactly one player'
          : 'Multiplayer needs at least two players',
      );
    }

    const questionCount = Number(room.questionCount);
    const snapshot = await this.buildSnapshot(room.bankId, questionCount);

    const gameId = randomUUID();
    const questionStartTime = Date.now();
    const multi = this.redis.client
      .multi()
      .hset(roomKey, { status: 'in_game', gameId })
      .hset(`game:${gameId}:state`, {
        roomId,
        currentIndex: 0,
        questionStartTime,
        roundStatus: 'question_active',
      })
      .expire(roomKey, ROOM_TTL_SECONDS)
      .expire(playersKey, ROOM_TTL_SECONDS)
      .expire(`game:${gameId}:state`, ROOM_TTL_SECONDS);
    for (const question of snapshot) {
      multi.hset(
        `game:${gameId}:questions`,
        question.index,
        JSON.stringify(question),
      );
    }
    multi.expire(`game:${gameId}:questions`, ROOM_TTL_SECONDS);
    await multi.exec();

    const timePerQuestionSeconds = Number(room.timePerQuestionSeconds);
    this.scheduleRoundTimer(gameId, roomId, timePerQuestionSeconds);
    const first = snapshot[0];
    return {
      roomId,
      gameStarted: {
        gameId,
        questionCount,
        timePerQuestionSeconds,
        players: Object.entries(players).map(([id, stored]) =>
          this.toView(id, stored),
        ),
      },
      questionStarted: {
        gameId,
        index: first.index,
        text: first.text,
        options: first.options,
        ...(first.imageUrl !== undefined && { imageUrl: first.imageUrl }),
        timeLimitSeconds: timePerQuestionSeconds,
        questionStartTime,
      },
    };
  }

  /**
   * Random questionCount ready questions of the bank, options shuffled per
   * question. Exactly one becomes the trap (logic.md): its correct option is
   * replaced by the spare distractor and correctIndex becomes null - all four
   * options are wrong, the structure is indistinguishable from a normal one.
   */
  private async buildSnapshot(
    bankId: string,
    questionCount: number,
  ): Promise<GameQuestionSnapshot[]> {
    const ready = await this.prisma.question.findMany({
      where: { bankId, answerSet: { status: { in: READY_STATUSES } } },
      include: { answerSet: true },
    });
    if (ready.length < questionCount) {
      throw new GameError(
        'start_conditions_not_met',
        'Not enough questions with accepted answer sets in the bank',
      );
    }

    const picked = this.shuffle(ready).slice(0, questionCount);
    const trapIndex = randomInt(questionCount);
    return picked.map((question, index) => {
      const answerSet = question.answerSet!;
      const order = this.shuffle([0, 1, 2, 3]);
      const options = order.map((position) => answerSet.options[position]);
      const correctIndex = order.indexOf(answerSet.correctIndex);
      const isTrap = index === trapIndex;
      if (isTrap) {
        options[correctIndex] = answerSet.spareDistractor;
      }
      return {
        index,
        baseQuestionId: question.id,
        text: question.text,
        options,
        correctIndex: isTrap ? null : correctIndex,
        isTrap,
        ...(question.imageUrl !== null && { imageUrl: question.imageUrl }),
        explanation: answerSet.explanation,
      };
    });
  }

  /** Unbiased Fisher-Yates on a copy (crypto randomInt). */
  private shuffle<T>(items: T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private async loadPlayers(
    playersKey: string,
  ): Promise<Record<string, StoredPlayer>> {
    const raw = await this.redis.client.hgetall(playersKey);
    return Object.fromEntries(
      Object.entries(raw).map(([id, value]) => [
        id,
        JSON.parse(value) as StoredPlayer,
      ]),
    );
  }

  private toView(playerId: string, stored: StoredPlayer): PlayerView {
    return {
      id: playerId,
      nickname: stored.nickname,
      isHost: stored.isHost,
      connected: stored.connected,
    };
  }

  private toRoomState(
    roomId: string,
    room: Record<string, string>,
    players: Record<string, StoredPlayer>,
  ): RoomState {
    return {
      roomId,
      status: room.status,
      settings: {
        mode: room.mode,
        questionCount: Number(room.questionCount),
        timePerQuestionSeconds: Number(room.timePerQuestionSeconds),
      },
      bankName: room.bankName,
      players: Object.entries(players).map(([id, stored]) =>
        this.toView(id, stored),
      ),
    };
  }
}
