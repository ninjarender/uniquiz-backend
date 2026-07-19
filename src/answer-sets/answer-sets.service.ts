import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AnswerSet } from '../../generated/prisma/client';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { AnswerSetView } from '../banks/banks.service';
import { PrismaService } from '../prisma/prisma.service';

/** Maps a stored answer set to the host-view OpenAPI AnswerSet schema. */
export function toAnswerSetView(answerSet: AnswerSet): AnswerSetView {
  return {
    id: answerSet.id,
    questionId: answerSet.questionId,
    options: answerSet.options,
    correctIndex: answerSet.correctIndex,
    spareDistractor: answerSet.spareDistractor,
    explanation: answerSet.explanation,
    status: answerSet.status,
    selfCheckPassed: answerSet.selfCheckPassed,
    generatedAt: answerSet.generatedAt,
    reviewedAt: answerSet.reviewedAt ?? undefined,
  };
}

@Injectable()
export class AnswerSetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Host accepts a generated set: in_review → accepted with reviewedAt.
   * 404 when the set does not exist or belongs to another host's bank
   * (same error); 409 for any status other than in_review.
   */
  async acceptAnswerSet(
    userId: string,
    answerSetId: string,
  ): Promise<AnswerSetView> {
    const answerSet = await this.prisma.answerSet.findFirst({
      where: { id: answerSetId, question: { bank: { userId } } },
    });
    if (!answerSet) {
      throw new NotFoundException('Answer set not found');
    }
    if (answerSet.status !== AnswerSetStatus.in_review) {
      throw new ConflictException('Answer set is not in review');
    }

    const updated = await this.prisma.answerSet.update({
      where: { id: answerSetId },
      data: { status: AnswerSetStatus.accepted, reviewedAt: new Date() },
    });
    return toAnswerSetView(updated);
  }
}
