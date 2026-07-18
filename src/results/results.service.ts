import { Injectable } from '@nestjs/common';
import { LeaderboardEntry } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';

/** One finished game of the host (openapi GameResult). */
export interface GameResultView {
  id: string;
  bankId: string;
  bankName?: string;
  mode: string;
  questionCount: number;
  finishedAt: Date;
  leaderboard: LeaderboardEntry[];
}

@Injectable()
export class ResultsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Finished games of the current host with final leaderboards, newest first. */
  async listGameResults(userId: string): Promise<GameResultView[]> {
    const results = await this.prisma.gameResult.findMany({
      where: { userId },
      orderBy: { finishedAt: 'desc' },
      include: { bank: { select: { name: true } } },
    });
    return results.map((result) => ({
      id: result.id,
      bankId: result.bankId,
      bankName: result.bank.name,
      mode: result.mode,
      questionCount: result.questionCount,
      finishedAt: result.finishedAt,
      leaderboard: result.leaderboard as unknown as LeaderboardEntry[],
    }));
  }
}
