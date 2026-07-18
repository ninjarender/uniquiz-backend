import { Test } from '@nestjs/testing';
import { GameError } from './game-error';
import { GameGateway } from './game.gateway';
import { GameService, JoinResult } from './game.service';

describe('GameGateway', () => {
  let gateway: GameGateway;
  const joinRoom = jest.fn();
  const rejoinRoom = jest.fn();
  const startGame = jest.fn();
  const handleDisconnect = jest.fn();
  const submitAnswer = jest.fn();
  const leaveRoom = jest.fn();
  const leave = jest.fn();
  const serverEmit = jest.fn();
  const emit = jest.fn();
  const roomEmit = jest.fn();
  const join = jest.fn();
  const to = jest.fn(() => ({ emit: roomEmit }));
  const client = () =>
    ({ data: {}, emit, join, leave, to }) as unknown as Parameters<
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
        {
          provide: GameService,
          useValue: {
            joinRoom,
            rejoinRoom,
            leaveRoom,
            startGame,
            submitAnswer,
            handleDisconnect,
          },
        },
      ],
    }).compile();
    gateway = moduleRef.get(GameGateway);
    gateway.server = { to: jest.fn(() => ({ emit: serverEmit })) } as never;
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

  it('rejoin_room: room_state to the caller, player_connection to the rest', async () => {
    rejoinRoom.mockResolvedValue({
      room: { roomId: 'r1', status: 'in_game' },
      player: { id: 'p-1', nickname: 'Olia', isHost: false, connected: true },
    });
    const socket = client();

    await gateway.handleRejoinRoom(socket, {
      roomId: 'r1',
      playerId: 'p-1',
      resumeToken: 'tok',
    });

    expect(join).toHaveBeenCalledWith('r1');
    expect(socket.data).toEqual({ roomId: 'r1', playerId: 'p-1' });
    expect(emit).toHaveBeenCalledWith('room_state', {
      roomId: 'r1',
      status: 'in_game',
    });
    expect(roomEmit).toHaveBeenCalledWith('player_connection', {
      playerId: 'p-1',
      connected: true,
    });
  });

  it('rejoin_room without resumeToken → invalid_payload', async () => {
    await gateway.handleRejoinRoom(client(), { roomId: 'r1', playerId: 'p' });

    expect(emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'invalid_payload' }),
    );
  });

  it('start_game: game_started then question_started to the whole room', async () => {
    startGame.mockResolvedValue({
      roomId: 'r1',
      gameStarted: { gameId: 'g1' },
      questionStarted: { gameId: 'g1', index: 0 },
    });
    const socket = client();
    socket.data.roomId = 'r1';
    socket.data.playerId = 'p-1';

    await gateway.handleStartGame(socket);

    expect(startGame).toHaveBeenCalledWith({ roomId: 'r1', playerId: 'p-1' });
    expect(serverEmit.mock.calls).toEqual([
      ['game_started', { gameId: 'g1' }],
      ['question_started', { gameId: 'g1', index: 0 }],
    ]);
  });

  it('start_game error → error event to the caller only', async () => {
    startGame.mockRejectedValue(new GameError('not_host', 'Only the host'));

    await gateway.handleStartGame(client());

    expect(emit).toHaveBeenCalledWith('error', {
      code: 'not_host',
      message: 'Only the host',
    });
  });

  it('leave_room: player_left (+host_changed) to the room, session cleared', async () => {
    leaveRoom.mockResolvedValue({
      roomId: 'r1',
      playerLeft: { playerId: 'p-1' },
      hostChanged: { playerId: 'p-2' },
    });
    const socket = client();
    socket.data.roomId = 'r1';
    socket.data.playerId = 'p-1';

    await gateway.handleLeaveRoom(socket);

    expect(leave).toHaveBeenCalledWith('r1');
    expect(socket.data).toEqual({ roomId: undefined, playerId: undefined });
    expect(serverEmit.mock.calls).toEqual([
      ['player_left', { playerId: 'p-1' }],
      ['host_changed', { playerId: 'p-2' }],
    ]);
  });

  it('leave_room from a non-member → not_a_member error', async () => {
    leaveRoom.mockRejectedValue(new GameError('not_a_member', 'nope'));

    await gateway.handleLeaveRoom(client());

    expect(emit).toHaveBeenCalledWith('error', {
      code: 'not_a_member',
      message: 'nope',
    });
    expect(serverEmit).not.toHaveBeenCalled();
  });

  it('submit_answer → submit_answer_ack to the sender', async () => {
    submitAnswer.mockResolvedValue({
      ack: { accepted: true, questionIndex: 1 },
      roomId: 'r1',
      allSubmitted: false,
    });
    const socket = client();
    socket.data.roomId = 'r1';
    socket.data.playerId = 'p-1';

    await gateway.handleSubmitAnswer(socket, {
      gameId: 'g1',
      questionIndex: 1,
      selectedOptionIndex: 2,
    });

    expect(submitAnswer).toHaveBeenCalledWith(
      { roomId: 'r1', playerId: 'p-1' },
      expect.objectContaining({
        gameId: 'g1',
        questionIndex: 1,
        selectedOptionIndex: 2,
      }),
    );
    expect(emit).toHaveBeenCalledWith('submit_answer_ack', {
      accepted: true,
      questionIndex: 1,
    });
  });

  it('submit_answer with an out-of-range option → invalid_payload', async () => {
    await gateway.handleSubmitAnswer(client(), {
      gameId: 'g1',
      questionIndex: 1,
      selectedOptionIndex: 4,
    });

    expect(submitAnswer).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'invalid_payload' }),
    );
  });

  it('disconnect of the host → host_changed to the room', async () => {
    handleDisconnect.mockResolvedValue({
      roomId: 'r1',
      hostChanged: { playerId: 'p-2' },
    });
    const socket = client();
    socket.data.roomId = 'r1';
    socket.data.playerId = 'p-1';

    await gateway.handleDisconnect(socket);

    expect(handleDisconnect).toHaveBeenCalledWith({
      roomId: 'r1',
      playerId: 'p-1',
    });
    expect(serverEmit).toHaveBeenCalledWith('host_changed', {
      playerId: 'p-2',
    });
  });

  it('disconnect of a regular player → no host_changed', async () => {
    handleDisconnect.mockResolvedValue({ roomId: 'r1' });

    await gateway.handleDisconnect(client());

    expect(serverEmit).not.toHaveBeenCalled();
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
