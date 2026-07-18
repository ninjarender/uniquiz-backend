import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
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

/** Both room keys live 24h without activity (data-model.md); joins refresh it. */
const ROOM_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class GameService {
  constructor(private readonly redis: RedisService) {}

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
