import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;
  const hgetall = jest.fn();
  const hget = jest.fn();
  const questionFindMany = jest.fn();
  const multiExec = jest.fn();
  const multiHset = jest.fn();
  const multiHdel = jest.fn();
  const multiExpire = jest.fn();

  const waitingRoom = {
    status: 'waiting',
    userId: 'host-1',
    bankId: 'bank-a',
    bankName: 'Біологія',
    hostNickname: 'Vadym',
    hostToken: 'secret-token',
    mode: 'multiplayer',
    questionCount: '5',
    timePerQuestionSeconds: '10',
    joinUrl: 'http://localhost:5173/join/r1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const multi = {
      hset: multiHset,
      hdel: multiHdel,
      expire: multiExpire,
      exec: multiExec,
    };
    multiHset.mockReturnValue(multi);
    multiHdel.mockReturnValue(multi);
    multiExpire.mockReturnValue(multi);
    multiExec.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: RedisService,
          useValue: { client: { hgetall, hget, multi: () => multi } },
        },
        {
          provide: PrismaService,
          useValue: { question: { findMany: questionFindMany } },
        },
      ],
    }).compile();
    service = moduleRef.get(GameService);
  });

  it('room_not_found for a missing room', async () => {
    hgetall.mockResolvedValue({});

    await expect(
      service.joinRoom({ roomId: 'nope', nickname: 'Olia' }),
    ).rejects.toMatchObject({ code: 'room_not_found' });
    expect(multiHset).not.toHaveBeenCalled();
  });

  it('room_not_waiting when the game is already running', async () => {
    hgetall.mockResolvedValueOnce({ ...waitingRoom, status: 'in_game' });

    await expect(
      service.joinRoom({ roomId: 'r1', nickname: 'Olia' }),
    ).rejects.toMatchObject({ code: 'room_not_waiting' });
  });

  it('nickname_taken for a duplicate nickname in the room', async () => {
    hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({
      'p-1': JSON.stringify({
        nickname: 'Olia',
        isHost: false,
        connected: true,
        resumeToken: 't',
      }),
    });

    await expect(
      service.joinRoom({ roomId: 'r1', nickname: 'Olia' }),
    ).rejects.toMatchObject({ code: 'nickname_taken' });
    expect(multiHset).not.toHaveBeenCalled();
  });

  it('joins a waiting room: stores the player, returns ack data + snapshot', async () => {
    hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({});

    const result = await service.joinRoom({ roomId: 'r1', nickname: 'Olia' });

    expect(result.playerId).toEqual(expect.any(String));
    expect(result.resumeToken).toEqual(expect.any(String));
    expect(result.player).toEqual({
      id: result.playerId,
      nickname: 'Olia',
      isHost: false,
      connected: true,
    });
    expect(result.room).toEqual({
      roomId: 'r1',
      status: 'waiting',
      settings: {
        mode: 'multiplayer',
        questionCount: 5,
        timePerQuestionSeconds: 10,
      },
      bankName: 'Біологія',
      players: [result.player],
    });
    expect(multiHset).toHaveBeenCalledWith(
      'room:r1:players',
      result.playerId,
      expect.any(String),
    );
    const hsetCalls = multiHset.mock.calls as string[][];
    const stored = JSON.parse(hsetCalls[0][2]) as {
      resumeToken: string;
    };
    expect(stored.resumeToken).toBe(result.resumeToken);
    expect(multiExpire).toHaveBeenCalledWith('room:r1', 24 * 60 * 60);
    expect(multiExpire).toHaveBeenCalledWith('room:r1:players', 24 * 60 * 60);
  });

  it('grants isHost for a matching hostToken and lists existing players', async () => {
    hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({
      'p-1': JSON.stringify({
        nickname: 'Olia',
        isHost: false,
        connected: true,
        resumeToken: 't',
      }),
    });

    const result = await service.joinRoom({
      roomId: 'r1',
      nickname: 'Vadym',
      hostToken: 'secret-token',
    });

    expect(result.player.isHost).toBe(true);
    expect(result.room.players).toHaveLength(2);
  });

  it('a wrong hostToken joins as a regular player', async () => {
    hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({});

    const result = await service.joinRoom({
      roomId: 'r1',
      nickname: 'Sneaky',
      hostToken: 'wrong',
    });

    expect(result.player.isHost).toBe(false);
  });

  it('a valid hostToken does not reclaim the role after a host_changed transfer', async () => {
    hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({
      'p-2': JSON.stringify({
        nickname: 'Olia',
        isHost: true,
        connected: true,
        resumeToken: 't',
        joinedAt: 1,
      }),
    });

    const result = await service.joinRoom({
      roomId: 'r1',
      nickname: 'Vadym',
      hostToken: 'secret-token',
    });

    expect(result.player.isHost).toBe(false);
  });

  describe('handleDisconnect', () => {
    const stored = (
      nickname: string,
      isHost: boolean,
      connected: boolean,
      joinedAt: number,
    ) => ({ nickname, isHost, connected, resumeToken: 't', joinedAt });
    const asHash = (players: Record<string, object>) =>
      Object.fromEntries(
        Object.entries(players).map(([id, player]) => [
          id,
          JSON.stringify(player),
        ]),
      );
    const writtenPlayers = () =>
      Object.fromEntries(
        (multiHset.mock.calls as string[][]).map(([, id, json]) => [
          id,
          JSON.parse(json) as { isHost: boolean; connected: boolean },
        ]),
      );

    it('null without a live session', async () => {
      expect(await service.handleDisconnect({})).toBeNull();
      expect(hgetall).not.toHaveBeenCalled();
    });

    it('a regular player drop: offline mark, no host change', async () => {
      hgetall.mockResolvedValueOnce(
        asHash({
          'p-host': stored('Vadym', true, true, 1),
          'p-2': stored('Olia', false, true, 2),
        }),
      );

      const result = await service.handleDisconnect({
        roomId: 'r1',
        playerId: 'p-2',
      });

      expect(result).toEqual({ roomId: 'r1' });
      expect(Object.keys(writtenPlayers())).toEqual(['p-2']);
      expect(writtenPlayers()['p-2']).toMatchObject({
        connected: false,
        isHost: false,
      });
    });

    it('host drop: the earliest-joined connected player becomes the host', async () => {
      hgetall.mockResolvedValueOnce(
        asHash({
          'p-host': stored('Vadym', true, true, 1),
          'p-2': stored('Olia', false, false, 2),
          'p-3': stored('Petro', false, true, 3),
          'p-4': stored('Ira', false, true, 4),
        }),
      );

      const result = await service.handleDisconnect({
        roomId: 'r1',
        playerId: 'p-host',
      });

      expect(result).toEqual({
        roomId: 'r1',
        hostChanged: { playerId: 'p-3' },
      });
      const written = writtenPlayers();
      expect(written['p-host']).toMatchObject({
        connected: false,
        isHost: false,
      });
      expect(written['p-3']).toMatchObject({ connected: true, isHost: true });
      expect(written['p-4']).toBeUndefined();
    });

    it('host drop with nobody else online: role stays, no broadcast', async () => {
      hgetall.mockResolvedValueOnce(
        asHash({
          'p-host': stored('Vadym', true, true, 1),
          'p-2': stored('Olia', false, false, 2),
        }),
      );

      const result = await service.handleDisconnect({
        roomId: 'r1',
        playerId: 'p-host',
      });

      expect(result).toEqual({ roomId: 'r1' });
      expect(writtenPlayers()['p-host']).toMatchObject({
        connected: false,
        isHost: true,
      });
    });
  });

  describe('rejoinRoom', () => {
    const stored = (resumeToken: string) =>
      JSON.stringify({
        nickname: 'Olia',
        isHost: false,
        connected: false,
        resumeToken,
      });
    const payload = { roomId: 'r1', playerId: 'p-1', resumeToken: 'tok' };

    it('room_not_found for a missing room', async () => {
      hgetall.mockResolvedValue({});

      await expect(service.rejoinRoom(payload)).rejects.toMatchObject({
        code: 'room_not_found',
      });
    });

    it('invalid_resume_token for a wrong token and for an unknown player', async () => {
      hgetall
        .mockResolvedValueOnce(waitingRoom)
        .mockResolvedValueOnce({ 'p-1': stored('other') })
        .mockResolvedValueOnce(waitingRoom)
        .mockResolvedValueOnce({});

      await expect(service.rejoinRoom(payload)).rejects.toMatchObject({
        code: 'invalid_resume_token',
      });
      await expect(service.rejoinRoom(payload)).rejects.toMatchObject({
        code: 'invalid_resume_token',
      });
      expect(multiHset).not.toHaveBeenCalled();
    });

    it('rejoin in the lobby: marks connected, returns the snapshot', async () => {
      hgetall
        .mockResolvedValueOnce(waitingRoom)
        .mockResolvedValueOnce({ 'p-1': stored('tok') });

      const { room, player } = await service.rejoinRoom(payload);

      expect(player).toEqual({
        id: 'p-1',
        nickname: 'Olia',
        isHost: false,
        connected: true,
      });
      expect(room.status).toBe('waiting');
      expect(room.currentQuestion).toBeUndefined();
      const hsetCalls = multiHset.mock.calls as string[][];
      expect(
        (JSON.parse(hsetCalls[0][2]) as { connected: boolean }).connected,
      ).toBe(true);
    });

    it('rejoin mid-round: snapshot carries the question with remainingSeconds', async () => {
      const questionStartTime = Date.now() - 4_000;
      hgetall
        .mockResolvedValueOnce({
          ...waitingRoom,
          status: 'in_game',
          gameId: 'g1',
        })
        .mockResolvedValueOnce({ 'p-1': stored('tok') })
        .mockResolvedValueOnce({
          roomId: 'r1',
          currentIndex: '1',
          questionStartTime: String(questionStartTime),
          roundStatus: 'question_active',
        });
      hget.mockResolvedValue(
        JSON.stringify({
          index: 1,
          baseQuestionId: 'q2',
          text: 'Питання 2?',
          options: ['a', 'b', 'c', 'd'],
          correctIndex: 2,
          isTrap: false,
        }),
      );

      const { room } = await service.rejoinRoom(payload);

      expect(hget).toHaveBeenCalledWith('game:g1:questions', '1');
      expect(room.currentQuestion).toMatchObject({
        gameId: 'g1',
        index: 1,
        text: 'Питання 2?',
        options: ['a', 'b', 'c', 'd'],
        timeLimitSeconds: 10,
        questionStartTime,
      });
      expect(room.currentQuestion!.remainingSeconds).toBeGreaterThan(4);
      expect(room.currentQuestion!.remainingSeconds).toBeLessThanOrEqual(6);
      expect(room.currentQuestion).not.toHaveProperty('correctIndex');
      expect(room.currentQuestion).not.toHaveProperty('isTrap');
    });
  });

  describe('leaveRoom', () => {
    const stored = (
      nickname: string,
      isHost: boolean,
      connected: boolean,
      joinedAt: number,
    ) =>
      JSON.stringify({
        nickname,
        isHost,
        connected,
        resumeToken: 't',
        joinedAt,
      });

    it('not_a_member without a session and for a non-member', async () => {
      await expect(service.leaveRoom({})).rejects.toMatchObject({
        code: 'not_a_member',
      });

      hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({});
      await expect(
        service.leaveRoom({ roomId: 'r1', playerId: 'ghost' }),
      ).rejects.toMatchObject({ code: 'not_a_member' });
      expect(multiHdel).not.toHaveBeenCalled();
    });

    it('room_not_waiting during a running game', async () => {
      hgetall.mockResolvedValueOnce({ ...waitingRoom, status: 'in_game' });

      await expect(
        service.leaveRoom({ roomId: 'r1', playerId: 'p-2' }),
      ).rejects.toMatchObject({ code: 'room_not_waiting' });
    });

    it('a regular player leaves: removed, no host change', async () => {
      hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({
        'p-host': stored('Vadym', true, true, 1),
        'p-2': stored('Olia', false, true, 2),
      });

      const result = await service.leaveRoom({ roomId: 'r1', playerId: 'p-2' });

      expect(result).toEqual({ roomId: 'r1', playerLeft: { playerId: 'p-2' } });
      expect(multiHdel).toHaveBeenCalledWith('room:r1:players', 'p-2');
      expect(multiHset).not.toHaveBeenCalled();
    });

    it('the host leaves: earliest-joined connected player inherits the role', async () => {
      hgetall.mockResolvedValueOnce(waitingRoom).mockResolvedValueOnce({
        'p-host': stored('Vadym', true, true, 1),
        'p-2': stored('Olia', false, false, 2),
        'p-3': stored('Petro', false, true, 3),
      });

      const result = await service.leaveRoom({
        roomId: 'r1',
        playerId: 'p-host',
      });

      expect(result).toEqual({
        roomId: 'r1',
        playerLeft: { playerId: 'p-host' },
        hostChanged: { playerId: 'p-3' },
      });
      expect(multiHdel).toHaveBeenCalledWith('room:r1:players', 'p-host');
      const hsetCalls = multiHset.mock.calls as string[][];
      expect(hsetCalls).toHaveLength(1);
      expect(hsetCalls[0][1]).toBe('p-3');
      expect((JSON.parse(hsetCalls[0][2]) as { isHost: boolean }).isHost).toBe(
        true,
      );
    });
  });

  describe('startGame', () => {
    const storedPlayer = (nickname: string, isHost: boolean) =>
      JSON.stringify({ nickname, isHost, connected: true, resumeToken: 't' });
    const twoPlayers = {
      'p-host': storedPlayer('Vadym', true),
      'p-2': storedPlayer('Olia', false),
    };
    const readyQuestion = (id: string) => ({
      id,
      bankId: 'bank-a',
      text: `Question ${id}`,
      imageUrl: null,
      referenceAnswer: null,
      createdAt: new Date(),
      answerSet: {
        options: [`correct-${id}`, 'w1', 'w2', 'w3'],
        correctIndex: 0,
        spareDistractor: `spare-${id}`,
        status: 'accepted',
      },
    });
    const session = { roomId: 'r1', playerId: 'p-host' };

    it('not_a_member without a joined session', async () => {
      await expect(service.startGame({})).rejects.toMatchObject({
        code: 'not_a_member',
      });
      expect(hgetall).not.toHaveBeenCalled();
    });

    it('room_not_waiting when the game is already running', async () => {
      hgetall.mockResolvedValueOnce({ ...waitingRoom, status: 'in_game' });

      await expect(service.startGame(session)).rejects.toMatchObject({
        code: 'room_not_waiting',
      });
    });

    it('not_host for a regular player', async () => {
      hgetall
        .mockResolvedValueOnce(waitingRoom)
        .mockResolvedValueOnce(twoPlayers);

      await expect(
        service.startGame({ roomId: 'r1', playerId: 'p-2' }),
      ).rejects.toMatchObject({ code: 'not_host' });
    });

    it('start_conditions_not_met: multiplayer with a single player', async () => {
      hgetall
        .mockResolvedValueOnce(waitingRoom)
        .mockResolvedValueOnce({ 'p-host': storedPlayer('Vadym', true) });

      await expect(service.startGame(session)).rejects.toMatchObject({
        code: 'start_conditions_not_met',
      });
      expect(questionFindMany).not.toHaveBeenCalled();
    });

    it('start_conditions_not_met: solo with two players', async () => {
      hgetall
        .mockResolvedValueOnce({ ...waitingRoom, mode: 'solo' })
        .mockResolvedValueOnce(twoPlayers);

      await expect(service.startGame(session)).rejects.toMatchObject({
        code: 'start_conditions_not_met',
      });
    });

    it('start_conditions_not_met when ready questions are fewer than questionCount', async () => {
      hgetall
        .mockResolvedValueOnce({ ...waitingRoom, questionCount: '3' })
        .mockResolvedValueOnce(twoPlayers);
      questionFindMany.mockResolvedValue([readyQuestion('q1')]);

      await expect(service.startGame(session)).rejects.toMatchObject({
        code: 'start_conditions_not_met',
      });
      expect(multiHset).not.toHaveBeenCalled();
    });

    it('starts the game: snapshot with one trap, in_game flip, both payloads', async () => {
      hgetall
        .mockResolvedValueOnce({ ...waitingRoom, questionCount: '2' })
        .mockResolvedValueOnce(twoPlayers);
      questionFindMany.mockResolvedValue([
        readyQuestion('q1'),
        readyQuestion('q2'),
        readyQuestion('q3'),
      ]);

      const result = await service.startGame(session);
      const { gameStarted, questionStarted } = result;

      expect(result.roomId).toBe('r1');
      expect(gameStarted.gameId).toEqual(expect.any(String));
      expect(gameStarted.questionCount).toBe(2);
      expect(gameStarted.timePerQuestionSeconds).toBe(10);
      expect(gameStarted.players).toHaveLength(2);

      expect(questionStarted.gameId).toBe(gameStarted.gameId);
      expect(questionStarted.index).toBe(0);
      expect(questionStarted.options).toHaveLength(4);
      expect(questionStarted.timeLimitSeconds).toBe(10);
      expect(questionStarted.questionStartTime).toEqual(expect.any(Number));
      expect(questionStarted).not.toHaveProperty('correctIndex');
      expect(questionStarted).not.toHaveProperty('isTrap');

      expect(multiHset).toHaveBeenCalledWith('room:r1', {
        status: 'in_game',
        gameId: gameStarted.gameId,
      });
      expect(multiHset).toHaveBeenCalledWith(
        `game:${gameStarted.gameId}:state`,
        expect.objectContaining({ roomId: 'r1', currentIndex: 0 }),
      );

      const questionCalls = (multiHset.mock.calls as unknown[][]).filter(
        ([key]) => key === `game:${gameStarted.gameId}:questions`,
      );
      const snapshot = questionCalls.map(
        ([, , json]) =>
          JSON.parse(json as string) as {
            index: number;
            isTrap: boolean;
            correctIndex: number | null;
            options: string[];
            baseQuestionId: string;
          },
      );
      expect(snapshot).toHaveLength(2);
      const traps = snapshot.filter((question) => question.isTrap);
      expect(traps).toHaveLength(1);
      expect(traps[0].correctIndex).toBeNull();
      expect(traps[0].options).toContain(`spare-${traps[0].baseQuestionId}`);
      expect(traps[0].options).not.toContain(
        `correct-${traps[0].baseQuestionId}`,
      );
      const normal = snapshot.find((question) => !question.isTrap)!;
      expect(normal.correctIndex).not.toBeNull();
      expect(normal.options[normal.correctIndex!]).toBe(
        `correct-${normal.baseQuestionId}`,
      );
    });
  });
});
