import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { GameMode } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RoomsService } from './rooms.service';

describe('RoomsService', () => {
  let service: RoomsService;
  const bankFindFirst = jest.fn();
  const questionCount = jest.fn();
  const hsetnx = jest.fn();
  const expire = jest.fn();
  const multiExec = jest.fn();
  const multiHset = jest.fn();
  const multiExpire = jest.fn();

  const body = {
    bankId: 'bank-a',
    hostNickname: 'Vadym',
    settings: {
      mode: GameMode.multiplayer,
      questionCount: 3,
      timePerQuestionSeconds: 10,
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const multi = {
      hset: multiHset,
      expire: multiExpire,
      exec: multiExec,
    };
    multiHset.mockReturnValue(multi);
    multiExpire.mockReturnValue(multi);
    multiExec.mockResolvedValue([]);
    hsetnx.mockResolvedValue(1);
    expire.mockResolvedValue(1);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: PrismaService,
          useValue: {
            bank: { findFirst: bankFindFirst },
            question: { count: questionCount },
          },
        },
        {
          provide: RedisService,
          useValue: { client: { hsetnx, expire, multi: () => multi } },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (_key: string, fallback: string) => fallback,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(RoomsService);
  });

  it('404 when the bank is missing or foreign', async () => {
    bankFindFirst.mockResolvedValue(null);

    await expect(service.createRoom('host-1', body)).rejects.toThrow(
      NotFoundException,
    );
    expect(hsetnx).not.toHaveBeenCalled();
  });

  it('409 when ready answer sets are fewer than questionCount', async () => {
    bankFindFirst.mockResolvedValue({ id: 'bank-a' });
    questionCount.mockResolvedValue(2);

    await expect(service.createRoom('host-1', body)).rejects.toThrow(
      ConflictException,
    );
    expect(hsetnx).not.toHaveBeenCalled();
  });

  it('creates a waiting room in Redis and returns roomId + joinUrl', async () => {
    bankFindFirst.mockResolvedValue({ id: 'bank-a' });
    questionCount.mockResolvedValue(3);

    const result = await service.createRoom('host-1', body);

    expect(result.roomId).toEqual(expect.any(String));
    expect(result.roomId.length).toBeGreaterThan(0);
    expect(result.joinUrl).toBe(`http://localhost:5173/join/${result.roomId}`);
    expect(questionCount).toHaveBeenCalledWith({
      where: {
        bankId: 'bank-a',
        answerSet: { status: { in: ['accepted', 'edited'] } },
      },
    });
    expect(multiHset).toHaveBeenCalledWith(`room:${result.roomId}`, {
      status: 'waiting',
      userId: 'host-1',
      bankId: 'bank-a',
      hostNickname: 'Vadym',
      mode: 'multiplayer',
      questionCount: 3,
      timePerQuestionSeconds: 10,
      joinUrl: result.joinUrl,
    });
    expect(multiExpire).toHaveBeenCalledWith(
      `room:${result.roomId}`,
      24 * 60 * 60,
    );
    expect(multiExec).toHaveBeenCalled();
  });

  it('retries the room id when the key already exists', async () => {
    bankFindFirst.mockResolvedValue({ id: 'bank-a' });
    questionCount.mockResolvedValue(3);
    hsetnx.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await service.createRoom('host-1', body);

    expect(hsetnx).toHaveBeenCalledTimes(2);
  });
});
