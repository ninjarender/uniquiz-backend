import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;
  const hgetall = jest.fn();
  const hget = jest.fn();
  const hmget = jest.fn();
  const hset = jest.fn();
  const hlenMock = jest.fn();
  const questionFindMany = jest.fn();
  const gameResultCreate = jest.fn();
  const zrangebyscore = jest.fn();
  const zscore = jest.fn();
  const zrem = jest.fn();
  const del = jest.fn();
  const multiExec = jest.fn();
  const multiHset = jest.fn();
  const multiHdel = jest.fn();
  const multiZadd = jest.fn();
  const multiZrem = jest.fn();
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
    jest.resetAllMocks();
    const multi = {
      hset: multiHset,
      hdel: multiHdel,
      zadd: multiZadd,
      zrem: multiZrem,
      expire: multiExpire,
      exec: multiExec,
    };
    multiHset.mockReturnValue(multi);
    multiHdel.mockReturnValue(multi);
    multiZadd.mockReturnValue(multi);
    multiZrem.mockReturnValue(multi);
    multiExpire.mockReturnValue(multi);
    multiExec.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: RedisService,
          useValue: {
            client: {
              hgetall,
              hget,
              hmget,
              hset,
              hlen: hlenMock,
              zrangebyscore,
              zscore,
              zrem,
              del,
              multi: () => multi,
            },
          },
        },
        {
          provide: PrismaService,
          useValue: {
            question: { findMany: questionFindMany },
            gameResult: { create: gameResultCreate },
          },
        },
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback: number) => fallback },
        },
      ],
    }).compile();
    service = moduleRef.get(GameService);
  });

  afterEach(() => {
    service.onModuleDestroy();
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

      expect(result).toEqual({ roomId: 'r1', playerId: 'p-2' });
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
        playerId: 'p-host',
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

      expect(result).toEqual({ roomId: 'r1', playerId: 'p-host' });
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
        })
        .mockResolvedValue({});
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
      expect(room.leaderboard).toEqual([
        { nickname: 'Olia', totalScore: 0, correctAnswers: 0 },
      ]);
    });

    it('rejoin in finished: final leaderboard, no current question', async () => {
      const answer = (score: number, isCorrect: boolean, elapsedMs: number) =>
        JSON.stringify({
          selectedOptionIndex: 0,
          isSubmitted: true,
          answerTime: 1,
          elapsedMs,
          score,
          isCorrect,
          auto: false,
        });
      hgetall
        .mockResolvedValueOnce({
          ...waitingRoom,
          status: 'finished',
          gameId: 'g1',
        })
        .mockResolvedValueOnce({
          'p-1': stored('tok'),
          'p-2': JSON.stringify({
            nickname: 'Vadym',
            isHost: true,
            connected: true,
            resumeToken: 'x',
            joinedAt: 1,
          }),
        })
        // buildLeaderboard: questions hash (index 1 is the trap), then answers
        .mockResolvedValueOnce({
          '0': JSON.stringify({ index: 0, isTrap: false }),
          '1': JSON.stringify({ index: 1, isTrap: true }),
        })
        .mockResolvedValueOnce({
          'p-1': answer(499.79, true, 7),
          'p-2': answer(440, true, 2000),
        })
        .mockResolvedValueOnce({
          'p-1': answer(0, false, 500),
          'p-2': answer(500, true, 0),
        });

      const { room } = await service.rejoinRoom(payload);

      expect(room.status).toBe('finished');
      expect(room.currentQuestion).toBeUndefined();
      expect(room.leaderboard).toEqual([
        {
          nickname: 'Vadym',
          totalScore: 940,
          correctAnswers: 2,
          avgResponseMs: 2000,
        },
        {
          nickname: 'Olia',
          totalScore: 500,
          correctAnswers: 1,
          avgResponseMs: 7,
        },
      ]);
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

  describe('submitAnswer', () => {
    const session = { roomId: 'r1', playerId: 'p-1' };
    const inGameRoom = { ...waitingRoom, status: 'in_game', gameId: 'g1' };
    const activeState = (startedMsAgo: number) => ({
      roomId: 'r1',
      currentIndex: '1',
      questionStartTime: String(Date.now() - startedMsAgo),
      roundStatus: 'question_active',
    });
    const question = (isTrap: boolean) =>
      JSON.stringify({
        index: 1,
        baseQuestionId: 'q2',
        text: 'x',
        options: ['a', 'b', 'c', 'd'],
        correctIndex: isTrap ? null : 2,
        isTrap,
      });
    const payload = { gameId: 'g1', questionIndex: 1, selectedOptionIndex: 2 };

    it('not_a_member without a session', async () => {
      await expect(service.submitAnswer({}, payload)).rejects.toMatchObject({
        code: 'not_a_member',
      });
    });

    it('invalid_payload for a gameId not matching the room', async () => {
      hgetall.mockResolvedValueOnce(inGameRoom);

      await expect(
        service.submitAnswer(session, { ...payload, gameId: 'other' }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('question_finished for a wrong index, closed round, or timeout', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce({ ...activeState(1000), currentIndex: '0' })
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce({
          ...activeState(1000),
          roundStatus: 'round_result',
        })
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(11_000));

      for (let i = 0; i < 3; i++) {
        await expect(
          service.submitAnswer(session, payload),
        ).rejects.toMatchObject({ code: 'question_finished' });
      }
      expect(multiHset).not.toHaveBeenCalled();
    });

    it('first correct answer: stored with server elapsed and exact score', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(2000));
      hget.mockResolvedValueOnce(null).mockResolvedValueOnce(question(false));
      hlenMock.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const result = await service.submitAnswer(session, payload);

      expect(result.ack).toEqual({ accepted: true, questionIndex: 1 });
      expect(result.allSubmitted).toBe(false);
      const hsetCalls = multiHset.mock.calls as string[][];
      expect(hsetCalls[0][0]).toBe('game:g1:answers:1');
      expect(hsetCalls[0][1]).toBe('p-1');
      const stored = JSON.parse(hsetCalls[0][2]) as {
        isCorrect: boolean;
        score: number;
        elapsedMs: number;
        auto: boolean;
        isSubmitted: boolean;
      };
      expect(stored.isSubmitted).toBe(true);
      expect(stored.isCorrect).toBe(true);
      expect(stored.auto).toBe(false);
      expect(stored.elapsedMs).toBeGreaterThanOrEqual(2000);
      expect(stored.elapsedMs).toBeLessThan(2500);
      expect(stored.score).toBeCloseTo(500 - (30 * stored.elapsedMs) / 1000, 5);
    });

    it('wrong option and any trap choice score 0', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(1000))
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(1000));
      hget
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(question(false))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(question(true));
      hlenMock
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);

      await service.submitAnswer(session, {
        ...payload,
        selectedOptionIndex: 0,
      });
      await service.submitAnswer(session, payload);

      const hsetCalls = multiHset.mock.calls as string[][];
      const wrong = JSON.parse(hsetCalls[0][2]) as {
        score: number;
        isCorrect: boolean;
      };
      const trap = JSON.parse(hsetCalls[1][2]) as {
        score: number;
        isCorrect: boolean;
      };
      expect(wrong).toMatchObject({ score: 0, isCorrect: false });
      expect(trap).toMatchObject({ score: 0, isCorrect: false });
    });

    it('a repeated submission is ignored with accepted=false', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(1000));
      hget.mockResolvedValueOnce(JSON.stringify({ isSubmitted: true }));

      const result = await service.submitAnswer(session, payload);

      expect(result.ack).toEqual({ accepted: false, questionIndex: 1 });
      expect(multiHset).not.toHaveBeenCalled();
    });

    it('the last submission closes the round early with a round_result', async () => {
      const playerJson = JSON.stringify({
        nickname: 'Olia',
        isHost: false,
        connected: true,
        resumeToken: 't',
        joinedAt: 1,
      });
      const answerJson = JSON.stringify({
        selectedOptionIndex: 2,
        isSubmitted: true,
        answerTime: 1,
        elapsedMs: 1000,
        score: 470,
        isCorrect: true,
        auto: false,
      });
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(1000))
        // closeRound: state re-read, players, answers
        .mockResolvedValueOnce(activeState(1000))
        .mockResolvedValueOnce({ 'p-1': playerJson })
        .mockResolvedValueOnce({ 'p-1': answerJson })
        // aggregateTotals: questions hash, answers of index 1
        .mockResolvedValueOnce({ '1': question(false) })
        .mockResolvedValueOnce({ 'p-1': answerJson });
      hget
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(question(false))
        .mockResolvedValueOnce(question(false));
      hmget.mockResolvedValueOnce(['10', '2']);
      hlenMock.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      const onRoundResult = jest.fn();
      service.onRoundResult = onRoundResult;

      const result = await service.submitAnswer(session, payload);

      expect(result.allSubmitted).toBe(true);
      expect(hset).toHaveBeenCalledWith(
        'game:g1:state',
        'roundStatus',
        'round_result',
      );
      expect(onRoundResult).toHaveBeenCalledWith(
        expect.objectContaining({
          gameId: 'g1',
          roomId: 'r1',
          questionIndex: 1,
          isLast: true,
          perPlayer: {
            'p-1': {
              selectedOptionIndex: 2,
              isCorrect: true,
              score: 470,
              elapsedMs: 1000,
              totalScore: 470,
            },
          },
        }),
      );
    });

    it('auto within the grace window is accepted and scored as taken at T', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(11_000));
      hget.mockResolvedValueOnce(null).mockResolvedValueOnce(question(false));
      hlenMock.mockResolvedValueOnce(5).mockResolvedValueOnce(1);

      const result = await service.submitAnswer(session, {
        ...payload,
        auto: true,
      });

      expect(result.ack.accepted).toBe(true);
      const hsetCalls = multiHset.mock.calls as string[][];
      const stored = JSON.parse(hsetCalls[0][2]) as {
        elapsedMs: number;
        score: number;
      };
      expect(stored.elapsedMs).toBe(10_000);
      expect(stored.score).toBe(200);
    });

    it('auto beyond the grace window → question_finished', async () => {
      hgetall
        .mockResolvedValueOnce(inGameRoom)
        .mockResolvedValueOnce(activeState(12_000));

      await expect(
        service.submitAnswer(session, { ...payload, auto: true }),
      ).rejects.toMatchObject({ code: 'question_finished' });
    });
  });

  describe('closeRound', () => {
    it('is idempotent: an already closed round is a no-op', async () => {
      hgetall.mockResolvedValueOnce({
        roomId: 'r1',
        currentIndex: '0',
        roundStatus: 'round_result',
      });

      expect(await service.closeRound('g1', 'r1')).toBeNull();
      expect(hset).not.toHaveBeenCalled();
    });

    it('records "no answer" for silent players: trap pays 500 and counts correct', async () => {
      const playerJson = (nickname: string) =>
        JSON.stringify({
          nickname,
          isHost: false,
          connected: true,
          resumeToken: 't',
          joinedAt: 1,
        });
      const answeredJson = JSON.stringify({
        selectedOptionIndex: 0,
        isSubmitted: true,
        answerTime: 1,
        elapsedMs: 2000,
        score: 0,
        isCorrect: false,
        auto: false,
      });
      hgetall
        .mockResolvedValueOnce({
          roomId: 'r1',
          currentIndex: '1',
          questionStartTime: '1',
          roundStatus: 'question_active',
        })
        .mockResolvedValueOnce({
          'p-1': playerJson('Olia'),
          'p-2': playerJson('Vadym'),
        })
        .mockResolvedValueOnce({ 'p-1': answeredJson })
        // aggregateTotals: questions, then answers of index 1
        .mockResolvedValueOnce({
          '1': JSON.stringify({ index: 1, isTrap: true }),
        })
        .mockResolvedValueOnce({ 'p-1': answeredJson });
      hget.mockResolvedValueOnce(JSON.stringify({ index: 1, isTrap: true }));
      hmget.mockResolvedValueOnce(['10', '3']);
      const onRoundResult = jest.fn();
      service.onRoundResult = onRoundResult;

      const result = await service.closeRound('g1', 'r1');

      expect(result).toEqual({ gameId: 'g1', roomId: 'r1', questionIndex: 1 });
      expect(hset).toHaveBeenCalledWith(
        'game:g1:state',
        'roundStatus',
        'round_result',
      );
      const hsetCalls = multiHset.mock.calls as string[][];
      expect(hsetCalls).toHaveLength(1);
      expect(hsetCalls[0][0]).toBe('game:g1:answers:1');
      expect(hsetCalls[0][1]).toBe('p-2');
      expect(JSON.parse(hsetCalls[0][2])).toMatchObject({
        selectedOptionIndex: null,
        isSubmitted: false,
        elapsedMs: 10_000,
        score: 500,
        isCorrect: true,
      });
      const resultCalls = onRoundResult.mock.calls as [
        { isLast: boolean; perPlayer: Record<string, object> },
      ][];
      const data = resultCalls[0][0];
      expect(data.isLast).toBe(false);
      expect(data.perPlayer['p-1']).toEqual({
        selectedOptionIndex: 0,
        isCorrect: false,
        score: 0,
        elapsedMs: 2000,
        totalScore: 0,
      });
      expect(data.perPlayer['p-2']).toEqual({
        selectedOptionIndex: null,
        isCorrect: true,
        score: 500,
        elapsedMs: null,
        totalScore: 0,
      });
    });

    it('advanceRound: next question, fresh state and question_started hook', async () => {
      hgetall.mockResolvedValueOnce({
        roomId: 'r1',
        currentIndex: '0',
        questionStartTime: '1',
        roundStatus: 'round_result',
      });
      hget
        .mockResolvedValueOnce(
          JSON.stringify({
            index: 1,
            baseQuestionId: 'q2',
            text: 'Питання 2?',
            options: ['a', 'b', 'c', 'd'],
            correctIndex: 0,
            isTrap: false,
          }),
        )
        .mockResolvedValueOnce('10');
      const onQuestionStarted = jest.fn();
      service.onQuestionStarted = onQuestionStarted;

      await service.advanceRound('g1', 'r1');

      expect(multiHset).toHaveBeenCalledWith(
        'game:g1:state',
        expect.objectContaining({
          currentIndex: 1,
          roundStatus: 'question_active',
        }),
      );
      expect(onQuestionStarted).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({
          gameId: 'g1',
          index: 1,
          text: 'Питання 2?',
          timeLimitSeconds: 10,
          questionStartTime: expect.any(Number) as number,
        }),
      );
      const questionCalls = onQuestionStarted.mock.calls as [string, object][];
      const payload = questionCalls[0][1];
      expect(payload).not.toHaveProperty('correctIndex');
      expect(payload).not.toHaveProperty('isTrap');
    });

    it('finishGame: full reveal, game_results insert, finished flip, 1h TTLs', async () => {
      const playerJson = JSON.stringify({
        nickname: 'Olia',
        isHost: true,
        connected: true,
        resumeToken: 't',
        joinedAt: 1,
      });
      const answerJson = JSON.stringify({
        selectedOptionIndex: 1,
        isSubmitted: true,
        answerTime: 1,
        elapsedMs: 1000,
        score: 470,
        isCorrect: true,
        auto: false,
      });
      const normalQ = JSON.stringify({
        index: 0,
        baseQuestionId: 'q1',
        text: 'Q1?',
        options: ['a', 'b', 'c', 'd'],
        correctIndex: 1,
        isTrap: false,
        explanation: 'бо так',
      });
      const trapQ = JSON.stringify({
        index: 1,
        baseQuestionId: 'q2',
        text: 'Q2?',
        options: ['a', 'b', 'c', 'd'],
        correctIndex: null,
        isTrap: true,
        explanation: 'пояснення trap',
      });
      hgetall
        .mockResolvedValueOnce({
          ...waitingRoom,
          status: 'in_game',
          gameId: 'g1',
          questionCount: '2',
        })
        .mockResolvedValueOnce({ 'p-1': playerJson })
        // aggregateTotals: questions, answers:0, answers:1
        .mockResolvedValueOnce({ '0': normalQ, '1': trapQ })
        .mockResolvedValueOnce({ 'p-1': answerJson })
        .mockResolvedValueOnce({ 'p-1': answerJson })
        // review questions hash
        .mockResolvedValueOnce({ '0': normalQ, '1': trapQ });
      gameResultCreate.mockResolvedValue({});
      const onGameOver = jest.fn();
      service.onGameOver = onGameOver;

      const payload = await service.finishGame('g1', 'r1');

      expect(payload).not.toBeNull();
      expect(payload!.trapQuestionIndex).toBe(1);
      expect(payload!.review).toEqual([
        {
          index: 0,
          text: 'Q1?',
          options: ['a', 'b', 'c', 'd'],
          correctIndex: 1,
          isTrap: false,
          explanation: 'бо так',
        },
        {
          index: 1,
          text: 'Q2?',
          options: ['a', 'b', 'c', 'd'],
          correctIndex: null,
          isTrap: true,
          explanation: 'пояснення trap',
        },
      ]);
      expect(payload!.leaderboard).toEqual([
        {
          nickname: 'Olia',
          totalScore: 940,
          correctAnswers: 2,
          avgResponseMs: 1000,
        },
      ]);
      const createCalls = gameResultCreate.mock.calls as [
        { data: Record<string, unknown> },
      ][];
      expect(createCalls[0][0].data).toMatchObject({
        userId: 'host-1',
        bankId: 'bank-a',
        mode: 'multiplayer',
        questionCount: 2,
        leaderboard: payload!.leaderboard,
      });
      expect(multiHset).toHaveBeenCalledWith('room:r1', 'status', 'finished');
      expect(multiExpire).toHaveBeenCalledWith('game:g1:state', 3600);
      expect(multiExpire).toHaveBeenCalledWith('game:g1:questions', 3600);
      expect(multiExpire).toHaveBeenCalledWith('game:g1:answers:0', 3600);
      expect(multiExpire).toHaveBeenCalledWith('game:g1:answers:1', 3600);
      expect(onGameOver).toHaveBeenCalledWith('r1', payload);
    });

    it('finishGame is idempotent: a finished room is a no-op', async () => {
      hgetall.mockResolvedValueOnce({
        ...waitingRoom,
        status: 'finished',
        gameId: 'g1',
      });

      expect(await service.finishGame('g1', 'r1')).toBeNull();
      expect(gameResultCreate).not.toHaveBeenCalled();
    });

    it('advanceRound is a no-op while the round is still active', async () => {
      hgetall.mockResolvedValueOnce({
        roomId: 'r1',
        currentIndex: '0',
        roundStatus: 'question_active',
      });
      const onQuestionStarted = jest.fn();
      service.onQuestionStarted = onQuestionStarted;

      await service.advanceRound('g1', 'r1');

      expect(multiHset).not.toHaveBeenCalled();
      expect(onQuestionStarted).not.toHaveBeenCalled();
    });
  });

  describe('lobby timeout', () => {
    it('armLobbyTimeout registers warning and deadline marks in Redis', async () => {
      const before = Date.now();

      await service.armLobbyTimeout('r1');

      const after = Date.now();
      const zaddCalls = multiZadd.mock.calls as [string, number, string][];
      expect(zaddCalls).toHaveLength(2);
      const [warnCall, deadlineCall] = zaddCalls;
      expect(warnCall[0]).toBe('lobby:warnings');
      expect(warnCall[2]).toBe('r1');
      expect(deadlineCall[0]).toBe('lobby:deadlines');
      expect(deadlineCall[2]).toBe('r1');
      expect(deadlineCall[1] - warnCall[1]).toBe(5 * 60 * 1000);
      expect(deadlineCall[1]).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
      expect(deadlineCall[1]).toBeLessThanOrEqual(after + 30 * 60 * 1000);
    });

    it('sweep fires room_closing_soon on the warning threshold', async () => {
      const now = 1_000_000;
      zrangebyscore
        .mockResolvedValueOnce(['r1']) // due warnings
        .mockResolvedValueOnce([]); // due closures
      hget.mockResolvedValueOnce('waiting');
      zscore.mockResolvedValueOnce(String(now + 300_000));
      const onRoomClosingSoon = jest.fn();
      service.onRoomClosingSoon = onRoomClosingSoon;

      await service.sweepLobbies(now);

      expect(zrem).toHaveBeenCalledWith('lobby:warnings', 'r1');
      expect(onRoomClosingSoon).toHaveBeenCalledWith('r1', {
        closesInSeconds: 300,
      });
      expect(del).not.toHaveBeenCalled();
    });

    it('sweep closes an expired lobby: room deleted, room_closed fired', async () => {
      zrangebyscore
        .mockResolvedValueOnce([]) // warnings
        .mockResolvedValueOnce(['r1']); // closures
      hget.mockResolvedValueOnce('waiting');
      const onRoomClosed = jest.fn();
      service.onRoomClosed = onRoomClosed;

      await service.sweepLobbies(1_000_000);

      expect(multiZrem).toHaveBeenCalledWith('lobby:deadlines', 'r1');
      expect(multiZrem).toHaveBeenCalledWith('lobby:warnings', 'r1');
      expect(del).toHaveBeenCalledWith('room:r1', 'room:r1:players');
      expect(onRoomClosed).toHaveBeenCalledWith('r1', {
        reason: 'lobby_timeout',
      });
    });

    it('sweep only unregisters rooms that left the waiting state', async () => {
      zrangebyscore.mockResolvedValueOnce([]).mockResolvedValueOnce(['r1']);
      hget.mockResolvedValueOnce('in_game');
      const onRoomClosed = jest.fn();
      service.onRoomClosed = onRoomClosed;

      await service.sweepLobbies(1_000_000);

      expect(del).not.toHaveBeenCalled();
      expect(onRoomClosed).not.toHaveBeenCalled();
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

    it('arms the round timer for the first question', async () => {
      jest.useFakeTimers();
      try {
        hgetall
          .mockResolvedValueOnce({ ...waitingRoom, questionCount: '2' })
          .mockResolvedValueOnce(twoPlayers);
        questionFindMany.mockResolvedValue([
          readyQuestion('q1'),
          readyQuestion('q2'),
        ]);

        await service.startGame(session);

        expect(jest.getTimerCount()).toBe(1);
      } finally {
        service.onModuleDestroy();
        jest.useRealTimers();
      }
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
      expect(multiZrem).toHaveBeenCalledWith('lobby:deadlines', 'r1');
      expect(multiZrem).toHaveBeenCalledWith('lobby:warnings', 'r1');
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
