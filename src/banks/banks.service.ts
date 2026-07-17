import { Injectable } from '@nestjs/common';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** Bank list item per the OpenAPI Bank schema. */
export interface BankListItem {
  id: string;
  name: string;
  questionCount: number;
  readyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Answer-set statuses that make a question playable (accepted/edited). */
const READY_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

@Injectable()
export class BanksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a bank for the current host; a fresh bank has zero counters. */
  async createBank(userId: string, name: string): Promise<BankListItem> {
    const bank = await this.prisma.bank.create({ data: { userId, name } });
    return {
      id: bank.id,
      name: bank.name,
      questionCount: 0,
      readyCount: 0,
      createdAt: bank.createdAt,
      updatedAt: bank.updatedAt,
    };
  }

  /**
   * Banks of the current host only, newest first. Both counters are computed
   * by PostgreSQL: questionCount via relation count, readyCount via a grouped
   * count of questions whose answer set is accepted/edited.
   */
  async listBanks(userId: string): Promise<BankListItem[]> {
    const banks = await this.prisma.bank.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { questions: true } } },
    });

    const readyCounts = await this.prisma.question.groupBy({
      by: ['bankId'],
      where: {
        bank: { userId },
        answerSet: { status: { in: READY_STATUSES } },
      },
      _count: { _all: true },
    });
    const readyByBank = new Map(
      readyCounts.map((row) => [row.bankId, row._count._all]),
    );

    return banks.map((bank) => ({
      id: bank.id,
      name: bank.name,
      questionCount: bank._count.questions,
      readyCount: readyByBank.get(bank.id) ?? 0,
      createdAt: bank.createdAt,
      updatedAt: bank.updatedAt,
    }));
  }
}
