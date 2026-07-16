import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BanksService } from './banks.service';

describe('BanksService', () => {
  let service: BanksService;
  const bankFindMany = jest.fn();
  const questionGroupBy = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BanksService,
        {
          provide: PrismaService,
          useValue: {
            bank: { findMany: bankFindMany },
            question: { groupBy: questionGroupBy },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(BanksService);
  });

  it('returns an empty list when the host has no banks', async () => {
    bankFindMany.mockResolvedValue([]);
    questionGroupBy.mockResolvedValue([]);

    await expect(service.listBanks('host-1')).resolves.toEqual([]);
    expect(bankFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'host-1' } }),
    );
  });

  it('maps counters; banks without ready sets get readyCount 0', async () => {
    const now = new Date();
    bankFindMany.mockResolvedValue([
      {
        id: 'bank-a',
        name: 'Lexis',
        createdAt: now,
        updatedAt: now,
        _count: { questions: 5 },
      },
      {
        id: 'bank-b',
        name: 'Grammar',
        createdAt: now,
        updatedAt: now,
        _count: { questions: 2 },
      },
    ]);
    questionGroupBy.mockResolvedValue([
      { bankId: 'bank-a', _count: { _all: 3 } },
    ]);

    await expect(service.listBanks('host-1')).resolves.toEqual([
      {
        id: 'bank-a',
        name: 'Lexis',
        questionCount: 5,
        readyCount: 3,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'bank-b',
        name: 'Grammar',
        questionCount: 2,
        readyCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  it('scopes both queries to the current host (isolation)', async () => {
    bankFindMany.mockResolvedValue([]);
    questionGroupBy.mockResolvedValue([]);

    await service.listBanks('host-42');

    expect(bankFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'host-42' } }),
    );
    expect(questionGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bank: { userId: 'host-42' } }),
      }),
    );
  });
});
