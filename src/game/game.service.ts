import { Injectable } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameError } from './game-error';
import { JoinRoomDto } from './dto/join-room.dto';

/** Player as seen by clients (common.yaml Player). */
export interface PlayerView {
  id: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
}

/** RoomState snapshot (waiting stage: no currentQuestion/leaderboard yet). */
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
    const stored: StoredPlayer = {
      nickname: payload.nickname,
      isHost:
        payload.hostToken !== undefined && payload.hostToken === room.hostToken,
      connected: true,
      resumeToken: randomBytes(24).toString('base64url'),
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
