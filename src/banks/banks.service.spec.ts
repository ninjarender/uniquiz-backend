import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BanksService } from './banks.service';

describe('BanksService', () => {
  let service: BanksService;
  const bankFindMany = jest.fn();
  const bankCreate = jest.fn();
  const bankFindFirst = jest.fn();
  const bankUpdateMany = jest.fn();
  const questionCount = jest.fn();
  const questionGroupBy = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BanksService,
        {
          provide: PrismaService,
          useValue: {
            bank: {
              findMany: bankFindMany,
              create: bankCreate,
              findFirst: bankFindFirst,
              updateMany: bankUpdateMany,
            },
            question: { groupBy: questionGroupBy, count: questionCount },
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

  describe('createBank', () => {
    it('creates a bank for the host and returns zero counters', async () => {
      const now = new Date();
      bankCreate.mockResolvedValue({
        id: 'bank-new',
        userId: 'host-1',
        name: 'Biology',
        createdAt: now,
        updatedAt: now,
      });

      await expect(service.createBank('host-1', 'Biology')).resolves.toEqual({
        id: 'bank-new',
        name: 'Biology',
        questionCount: 0,
        readyCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      expect(bankCreate).toHaveBeenCalledWith({
        data: { userId: 'host-1', name: 'Biology' },
      });
    });
  });

  describe('getBank', () => {
    it('404 for a missing or foreign bank (same error)', async () => {
      bankFindFirst.mockResolvedValue(null);

      await expect(service.getBank('host-1', 'bank-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('maps BankDetailed with host-view answer sets and ready count', async () => {
      const now = new Date();
      bankFindFirst.mockResolvedValue({
        id: 'bank-a',
        userId: 'host-1',
        name: 'Lexis',
        createdAt: now,
        updatedAt: now,
        _count: { questions: 2 },
        questions: [
          {
            id: 'q-1',
            bankId: 'bank-a',
            text: 'Apple?',
            imageUrl: null,
            referenceAnswer: 'fruit',
            createdAt: now,
            answerSet: {
              id: 'set-1',
              questionId: 'q-1',
              options: ['a', 'b', 'c', 'd'],
              correctIndex: 2,
              spareDistractor: 'e',
              explanation: 'why',
              status: 'accepted',
              selfCheckPassed: true,
              generatedAt: now,
              reviewedAt: null,
            },
          },
          {
            id: 'q-2',
            bankId: 'bank-a',
            text: 'Pear?',
            imageUrl: 'https://img/2.png',
            referenceAnswer: null,
            createdAt: now,
            answerSet: null,
          },
        ],
      });

      const bank = await service.getBank('host-1', 'bank-a');

      expect(bank.questionCount).toBe(2);
      expect(bank.readyCount).toBe(1);
      expect(bank.questions[0].answerSet?.correctIndex).toBe(2);
      expect(bank.questions[1].answerSet).toBeUndefined();
      expect(bank.questions[1].imageUrl).toBe('https://img/2.png');
    });
  });

  describe('renameBank', () => {
    it('404 when the bank is missing or foreign', async () => {
      bankUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.renameBank('host-1', 'bank-x', 'New name'),
      ).rejects.toThrow(NotFoundException);
      expect(bankUpdateMany).toHaveBeenCalledWith({
        where: { id: 'bank-x', userId: 'host-1' },
        data: { name: 'New name' },
      });
    });

    it('renames own bank and returns fresh counters', async () => {
      const now = new Date();
      bankUpdateMany.mockResolvedValue({ count: 1 });
      bankFindFirst.mockResolvedValue({
        id: 'bank-a',
        userId: 'host-1',
        name: 'Renamed',
        createdAt: now,
        updatedAt: now,
        _count: { questions: 4 },
      });
      questionCount.mockResolvedValue(2);

      await expect(
        service.renameBank('host-1', 'bank-a', 'Renamed'),
      ).resolves.toEqual({
        id: 'bank-a',
        name: 'Renamed',
        questionCount: 4,
        readyCount: 2,
        createdAt: now,
        updatedAt: now,
      });
    });
  });
});
