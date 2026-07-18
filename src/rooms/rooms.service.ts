import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { GameService } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RoomCreateDto, RoomSettingsDto } from './dto/room-create.dto';

/** RoomPublicInfo per common.yaml: the join page and the PATCH response. */
export interface RoomPublicInfo {
  roomId: string;
  status: string;
  settings: {
    mode: string;
    questionCount: number;
    timePerQuestionSeconds: number;
  };
  bankName: string;
}

/** RoomCreated response: id, the link the host shares, and the host's secret. */
export interface RoomCreated {
  roomId: string;
  joinUrl: string;
  hostToken: string;
}

/** Answer-set statuses that make a question playable (accepted/edited). */
const READY_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

/** room:{roomId} hash lives 24h without activity (data-model.md). */
const ROOM_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class RoomsService {
  private readonly joinBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gameService: GameService,
    config: ConfigService,
  ) {
    this.joinBaseUrl = config.get<string>(
      'PUBLIC_WEB_URL',
      'http://localhost:5173',
    );
  }

  /**
   * PATCH /rooms/{roomId}: host-only (foreign room = 404), waiting-only (409).
   * Updates the Redis room state and announces settings_updated to the lobby.
   */
  async updateSettings(
    userId: string,
    roomId: string,
    settings: RoomSettingsDto,
  ): Promise<RoomPublicInfo> {
    const roomKey = `room:${roomId}`;
    const room = await this.redis.client.hgetall(roomKey);
    if (Object.keys(room).length === 0 || room.userId !== userId) {
      throw new NotFoundException('Room not found');
    }
    if (room.status !== 'waiting') {
      throw new ConflictException(
        'Settings can change only while the room is waiting',
      );
    }

    await this.redis.client
      .multi()
      .hset(roomKey, {
        mode: settings.mode,
        questionCount: settings.questionCount,
        timePerQuestionSeconds: settings.timePerQuestionSeconds,
      })
      .expire(roomKey, ROOM_TTL_SECONDS)
      .exec();

    const updated = {
      mode: settings.mode as string,
      questionCount: settings.questionCount,
      timePerQuestionSeconds: settings.timePerQuestionSeconds,
    };
    this.gameService.notifySettingsUpdated(roomId, updated);
    return {
      roomId,
      status: room.status,
      settings: updated,
      bankName: room.bankName,
    };
  }

  /**
   * Creates a waiting room in Redis for the host's own bank.
   * 404 for a missing/foreign bank (same error); 409 when the bank has fewer
   * accepted/edited answer sets than settings.questionCount.
   */
  async createRoom(userId: string, body: RoomCreateDto): Promise<RoomCreated> {
    const bank = await this.prisma.bank.findFirst({
      where: { id: body.bankId, userId },
      select: { id: true, name: true },
    });
    if (!bank) {
      throw new NotFoundException('Bank not found');
    }

    const readyCount = await this.prisma.question.count({
      where: {
        bankId: body.bankId,
        answerSet: { status: { in: READY_STATUSES } },
      },
    });
    if (readyCount < body.settings.questionCount) {
      throw new ConflictException(
        'Not enough questions with accepted answer sets in the bank',
      );
    }

    const roomId = await this.reserveRoomId();
    const joinUrl = `${this.joinBaseUrl}/join/${roomId}`;
    // hostToken never reaches anyone but the creator; its bearer gets
    // isHost=true on join_room (asyncapi JoinRoomPayload.hostToken).
    const hostToken = randomBytes(24).toString('base64url');
    await this.redis.client
      .multi()
      .hset(`room:${roomId}`, {
        status: 'waiting',
        userId,
        bankId: body.bankId,
        bankName: bank.name,
        hostNickname: body.hostNickname,
        hostToken,
        mode: body.settings.mode,
        questionCount: body.settings.questionCount,
        timePerQuestionSeconds: body.settings.timePerQuestionSeconds,
        joinUrl,
      })
      .expire(`room:${roomId}`, ROOM_TTL_SECONDS)
      .exec();

    return { roomId, joinUrl, hostToken };
  }

  /**
   * Short URL-safe room id; HSETNX on the status field guarantees we never
   * silently overwrite a live room on a rare collision.
   */
  private async reserveRoomId(): Promise<string> {
    for (;;) {
      const roomId = randomBytes(8).toString('base64url');
      const reserved = await this.redis.client.hsetnx(
        `room:${roomId}`,
        'status',
        'waiting',
      );
      if (reserved === 1) {
        // TTL immediately: if the request dies before the main HSET+EXPIRE,
        // the reserved key must not live forever.
        await this.redis.client.expire(`room:${roomId}`, ROOM_TTL_SECONDS);
        return roomId;
      }
    }
  }
}
