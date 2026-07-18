import { Test } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;
  const hgetall = jest.fn();
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
});
