import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { ResultsService } from './results.service';

describe('ResultsService', () => {
  let service: ResultsService;
  const findMany = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ResultsService,
        {
          provide: PrismaService,
          useValue: { gameResult: { findMany } },
        },
      ],
    }).compile();
    service = moduleRef.get(ResultsService);
  });

  it('empty history is an empty array', async () => {
    findMany.mockResolvedValue([]);

    expect(await service.listGameResults('host-1')).toEqual([]);
  });

  it('queries only the current host, newest first, and maps bankName', async () => {
    const finishedAt = new Date('2026-07-18T12:00:00Z');
    const leaderboard = [
      { nickname: 'Olia', totalScore: 940, correctAnswers: 2 },
    ];
    findMany.mockResolvedValue([
      {
        id: 'gr-1',
        userId: 'host-1',
        bankId: 'bank-a',
        mode: 'multiplayer',
        questionCount: 2,
        finishedAt,
        leaderboard,
        bank: { name: 'Біологія' },
      },
    ]);

    const results = await service.listGameResults('host-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'host-1' },
      orderBy: { finishedAt: 'desc' },
      include: { bank: { select: { name: true } } },
    });
    expect(results).toEqual([
      {
        id: 'gr-1',
        bankId: 'bank-a',
        bankName: 'Біологія',
        mode: 'multiplayer',
        questionCount: 2,
        finishedAt,
        leaderboard,
      },
    ]);
  });
});
