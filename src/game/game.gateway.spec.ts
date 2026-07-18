import { Test } from '@nestjs/testing';
import { GameError } from './game-error';
import { GameGateway } from './game.gateway';
import { GameService, JoinResult } from './game.service';

describe('GameGateway', () => {
  let gateway: GameGateway;
  const joinRoom = jest.fn();
  const emit = jest.fn();
  const roomEmit = jest.fn();
  const join = jest.fn();
  const to = jest.fn(() => ({ emit: roomEmit }));
  const client = () =>
    ({ data: {}, emit, join, to }) as unknown as Parameters<
      GameGateway['handleJoinRoom']
    >[0];

  const joinResult: JoinResult = {
    playerId: 'p-1',
    resumeToken: 'tok',
    room: {
      roomId: 'r1',
      status: 'waiting',
      settings: { mode: 'solo', questionCount: 5, timePerQuestionSeconds: 10 },
      bankName: 'Біологія',
      players: [],
    },
    player: { id: 'p-1', nickname: 'Olia', isHost: false, connected: true },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        GameGateway,
        { provide: GameService, useValue: { joinRoom } },
      ],
    }).compile();
    gateway = moduleRef.get(GameGateway);
  });

  it('join_room: join_ack to the joiner, player_joined to the rest', async () => {
    joinRoom.mockResolvedValue(joinResult);
    const socket = client();

    await gateway.handleJoinRoom(socket, { roomId: 'r1', nickname: 'Olia' });

    expect(join).toHaveBeenCalledWith('r1');
    expect(socket.data).toEqual({ roomId: 'r1', playerId: 'p-1' });
    expect(emit).toHaveBeenCalledWith('join_ack', {
      playerId: 'p-1',
      resumeToken: 'tok',
      room: joinResult.room,
    });
    expect(to).toHaveBeenCalledWith('r1');
    expect(roomEmit).toHaveBeenCalledWith('player_joined', {
      player: joinResult.player,
    });
  });

  it('invalid payload → error(invalid_payload), service not called', async () => {
    await gateway.handleJoinRoom(client(), { roomId: 'r1' });

    expect(joinRoom).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'invalid_payload' }),
    );
  });

  it('GameError from the service → error event with its code', async () => {
    joinRoom.mockRejectedValue(new GameError('room_not_waiting', 'nope'));

    await gateway.handleJoinRoom(client(), { roomId: 'r1', nickname: 'Olia' });

    expect(emit).toHaveBeenCalledWith('error', {
      code: 'room_not_waiting',
      message: 'nope',
    });
  });
});
