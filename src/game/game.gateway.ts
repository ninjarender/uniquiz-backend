import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
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
import { RejoinRoomDto } from './dto/rejoin-room.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import { GameService, RoundResultData } from './game.service';

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
export class GameGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly gameService: GameService) {
    this.gameService.onRoundResult = (data) =>
      void this.broadcastRoundResult(data);
    this.gameService.onQuestionStarted = (roomId, question) =>
      this.server.to(roomId).emit('question_started', question);
    this.gameService.onGameOver = (roomId, payload) =>
      this.server.to(roomId).emit('game_over', payload);
    this.gameService.onSettingsUpdated = (roomId, settings) =>
      this.server.to(roomId).emit('settings_updated', { settings });
    this.gameService.onRoomClosingSoon = (roomId, payload) =>
      this.server.to(roomId).emit('room_closing_soon', payload);
    this.gameService.onRoomClosed = (roomId, payload) => {
      this.server.to(roomId).emit('room_closed', payload);
      // evict the sockets - the room no longer exists
      this.server.in(roomId).socketsLeave(roomId);
    };
  }

  /**
   * round_result is personal: each connected player gets their own result
   * with the shared leaderboard; the correct option is never revealed.
   */
  private async broadcastRoundResult(data: RoundResultData): Promise<void> {
    const sockets = await this.server
      .in(data.roomId)
      .fetchSockets()
      .catch(() => []);
    for (const socket of sockets) {
      const session = socket.data as SocketSession;
      const yourResult = session.playerId
        ? data.perPlayer[session.playerId]
        : undefined;
      if (yourResult) {
        socket.emit('round_result', {
          questionIndex: data.questionIndex,
          yourResult,
          leaderboard: data.leaderboard,
          isLast: data.isLast,
        });
      }
    }
  }

  /**
   * Socket drop → offline mark in Redis; if the host dropped, host_changed
   * with the successor goes to the whole room. (player_connection broadcast
   * for regular drops - task 0031.)
   */
  async handleDisconnect(client: GameSocket): Promise<void> {
    const result = await this.gameService
      .handleDisconnect(client.data)
      .catch(() => null);
    if (result?.hostChanged) {
      this.server.to(result.roomId).emit('host_changed', result.hostChanged);
    }
  }

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
   * rejoin_room → room_state snapshot to the reconnecting player +
   * player_connection(connected=true) to the rest. Works at any stage.
   */
  @SubscribeMessage('rejoin_room')
  async handleRejoinRoom(
    @ConnectedSocket() client: GameSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    try {
      const payload = await this.parse(RejoinRoomDto, body);
      const { room, player } = await this.gameService.rejoinRoom(payload);

      client.data.roomId = payload.roomId;
      client.data.playerId = player.id;
      await client.join(payload.roomId);

      client.emit('room_state', room);
      client.to(payload.roomId).emit('player_connection', {
        playerId: player.id,
        connected: true,
      });
    } catch (error) {
      this.emitError(client, error);
    }
  }

  /**
   * leave_room (lobby only, no payload) → player_left to the remaining
   * players, plus host_changed when the leaver was the host.
   */
  @SubscribeMessage('leave_room')
  async handleLeaveRoom(@ConnectedSocket() client: GameSocket): Promise<void> {
    try {
      const { roomId, playerLeft, hostChanged } =
        await this.gameService.leaveRoom(client.data);

      await client.leave(roomId);
      client.data.roomId = undefined;
      client.data.playerId = undefined;

      this.server.to(roomId).emit('player_left', playerLeft);
      if (hostChanged) {
        this.server.to(roomId).emit('host_changed', hostChanged);
      }
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

  /**
   * submit_answer → submit_answer_ack to the sender. When the last player
   * submits, the round is marked closed (round_result broadcast - task 0038).
   */
  @SubscribeMessage('submit_answer')
  async handleSubmitAnswer(
    @ConnectedSocket() client: GameSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    try {
      const payload = await this.parse(SubmitAnswerDto, body);
      const { ack } = await this.gameService.submitAnswer(client.data, payload);
      client.emit('submit_answer_ack', ack);
    } catch (error) {
      this.emitError(client, error);
    }
  }

  /**
   * sync_time (no payload) → sync_time_ack with the server clock (Unix ms) to
   * the same socket. The client calls it when its local timer drifts ~500ms+
   * from questionStartTime; scores always use server time regardless.
   */
  @SubscribeMessage('sync_time')
  handleSyncTime(@ConnectedSocket() client: GameSocket): void {
    client.emit('sync_time_ack', { serverTime: Date.now() });
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
