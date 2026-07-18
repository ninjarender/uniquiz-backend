import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;
  const hgetall = jest.fn();
  const questionFindMany = jest.fn();
  const multiExec = jest.fn();
  const multiHset = jest.fn();
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
    const multi = { hset: multiHset, expire: multiExpire, exec: multiExec };
    multiHset.mockReturnValue(multi);
    multiExpire.mockReturnValue(multi);
    multiExec.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: RedisService,
          useValue: { client: { hgetall, multi: () => multi } },
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
