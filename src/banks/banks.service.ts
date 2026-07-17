import { Injectable, NotFoundException } from '@nestjs/common';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** Host-view answer set per the OpenAPI AnswerSet schema. */
export interface AnswerSetView {
  id: string;
  questionId: string;
  options: string[];
  correctIndex: number;
  spareDistractor: string;
  explanation: string;
  status: string;
  selfCheckPassed: boolean;
  generatedAt: Date;
  reviewedAt?: Date;
}

/** Host-view question per the OpenAPI Question schema. */
export interface QuestionView {
  id: string;
  bankId: string;
  text: string;
  imageUrl?: string;
  referenceAnswer?: string;
  answerSet?: AnswerSetView;
}

/** Bank list item per the OpenAPI Bank schema. */
export interface BankListItem {
  id: string;
  name: string;
  questionCount: number;
  readyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** BankDetailed: bank plus its questions with host-view answer sets. */
export interface BankDetailed extends BankListItem {
  questions: QuestionView[];
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
   * Bank of the current host with all questions and their host-view answer
   * sets (correctIndex, explanation, spare distractor included - host content).
   * 404 when the bank does not exist or belongs to another host (same error).
   */
  async getBank(userId: string, bankId: string): Promise<BankDetailed> {
    const bank = await this.prisma.bank.findFirst({
      where: { id: bankId, userId },
      include: {
        _count: { select: { questions: true } },
        questions: {
          orderBy: { createdAt: 'asc' },
          include: { answerSet: true },
        },
      },
    });
    if (!bank) {
      throw new NotFoundException('Bank not found');
    }

    const questions: QuestionView[] = bank.questions.map((question) => ({
      id: question.id,
      bankId: question.bankId,
      text: question.text,
      imageUrl: question.imageUrl ?? undefined,
      referenceAnswer: question.referenceAnswer ?? undefined,
      answerSet: question.answerSet
        ? {
            id: question.answerSet.id,
            questionId: question.answerSet.questionId,
            options: question.answerSet.options,
            correctIndex: question.answerSet.correctIndex,
            spareDistractor: question.answerSet.spareDistractor,
            explanation: question.answerSet.explanation,
            status: question.answerSet.status,
            selfCheckPassed: question.answerSet.selfCheckPassed,
            generatedAt: question.answerSet.generatedAt,
            reviewedAt: question.answerSet.reviewedAt ?? undefined,
          }
        : undefined,
    }));

    return {
      id: bank.id,
      name: bank.name,
      questionCount: bank._count.questions,
      readyCount: questions.filter(
        (question) =>
          question.answerSet !== undefined &&
          READY_STATUSES.includes(question.answerSet.status as AnswerSetStatus),
      ).length,
      createdAt: bank.createdAt,
      updatedAt: bank.updatedAt,
      questions,
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
