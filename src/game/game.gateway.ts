import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DefaultEventsMap, Socket } from 'socket.io';
import { GameError } from './game-error';
import { JoinRoomDto } from './dto/join-room.dto';
import { GameService } from './game.service';

/** Per-socket session: which player in which room this connection is. */
interface SocketSession {
  roomId?: string;
  playerId?: string;
}

type GameSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketSession
>;

/**
 * Single Socket.IO namespace (asyncapi channel address "/"); room isolation
 * via Socket.IO rooms keyed by roomId. Event names are snake_case per contract.
 */
@WebSocketGateway({ cors: { origin: true } })
export class GameGateway {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly gameService: GameService) {}

  /** join_room → join_ack to the joiner + player_joined to the rest of the room. */
  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: GameSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    try {
      const payload = await this.parse(JoinRoomDto, body);
      const { playerId, resumeToken, room, player } =
        await this.gameService.joinRoom(payload);

      client.data.roomId = payload.roomId;
      client.data.playerId = playerId;
      await client.join(payload.roomId);

      client.emit('join_ack', { playerId, resumeToken, room });
      client.to(payload.roomId).emit('player_joined', { player });
    } catch (error) {
      this.emitError(client, error);
    }
  }

  /**
   * start_game (host, no payload) → game_started to the whole room, then the
   * first question_started (contract order: game_started strictly first).
   */
  @SubscribeMessage('start_game')
  async handleStartGame(@ConnectedSocket() client: GameSocket): Promise<void> {
    try {
      const { roomId, gameStarted, questionStarted } =
        await this.gameService.startGame(client.data);

      this.server.to(roomId).emit('game_started', gameStarted);
      this.server.to(roomId).emit('question_started', questionStarted);
    } catch (error) {
      this.emitError(client, error);
    }
  }

  /** Validates a raw event payload into a DTO; invalid_payload on failure. */
  private async parse<T extends object>(
    dtoClass: new () => T,
    body: unknown,
  ): Promise<T> {
    const dto = plainToInstance(dtoClass, body ?? {});
    const errors = await validate(dto, { whitelist: true });
    if (errors.length > 0) {
      throw new GameError(
        'invalid_payload',
        errors
          .flatMap((error) => Object.values(error.constraints ?? {}))
          .join('; ') || 'Validation failed',
      );
    }
    return dto;
  }

  /** Every rejection is an `error` event with an asyncapi ErrorPayload. */
  private emitError(client: GameSocket, error: unknown): void {
    if (error instanceof GameError) {
      client.emit('error', { code: error.code, message: error.message });
      return;
    }
    client.emit('error', {
      code: 'invalid_payload',
      message: 'Unexpected server error',
    });
  }
}
