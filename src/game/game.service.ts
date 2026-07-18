import { Injectable } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { ChainableCommander } from 'ioredis';
import { AnswerSetStatus } from '../../generated/prisma/enums';
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
  selectedOptionIndex: number;
  isSubmitted: boolean;
  answerTime: number;
  elapsedMs: number;
  score: number;
  isCorrect: boolean;
  auto: boolean;
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
}

/** Answer-set statuses that make a question playable (accepted/edited). */
const READY_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

/** Both room keys live 24h without activity (data-model.md); joins refresh it. */
const ROOM_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class GameService {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

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

    const totals = new Map<
      string,
      { totalScore: number; correctAnswers: number; responseTimes: number[] }
    >();
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

    return { roomId, ...(hostChanged && { hostChanged }) };
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
    if (
      state.roundStatus !== 'question_active' ||
      payload.questionIndex !== Number(state.currentIndex) ||
      elapsedMs > timeLimitMs
    ) {
      throw new GameError('question_finished', 'This round is already over');
    }

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
    const score = isCorrect ? Math.max(500 - (30 * elapsedMs) / 1000, 0) : 0;
    const stored: StoredAnswer = {
      selectedOptionIndex: payload.selectedOptionIndex,
      isSubmitted: true,
      answerTime,
      elapsedMs,
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
      // Early close marker; the round_result flow (0038) picks it up.
      await this.redis.client.hset(stateKey, 'roundStatus', 'round_result');
    }

    return {
      ack: { accepted: true, questionIndex: payload.questionIndex },
      roomId,
      allSubmitted,
    };
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
