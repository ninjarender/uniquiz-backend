import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AnswerSet } from '../../generated/prisma/client';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { AnswerSetView } from '../banks/banks.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnswerSetPatchDto } from './dto/answer-set-patch.dto';

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

  /**
   * Manual host edit of options, correct index, explanation or spare
   * distractor. Any edit moves the set to edited (counts as accepted) and
   * stamps reviewedAt. 404 for a missing/foreign set; 400 when the patch
   * carries no fields (contract minProperties: 1).
   */
  async updateAnswerSet(
    userId: string,
    answerSetId: string,
    patch: AnswerSetPatchDto,
  ): Promise<AnswerSetView> {
    const data: Record<string, unknown> = {};
    if (patch.options !== undefined) data.options = patch.options;
    if (patch.correctIndex !== undefined)
      data.correctIndex = patch.correctIndex;
    if (patch.spareDistractor !== undefined)
      data.spareDistractor = patch.spareDistractor;
    if (patch.explanation !== undefined) data.explanation = patch.explanation;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    const answerSet = await this.prisma.answerSet.findFirst({
      where: { id: answerSetId, question: { bank: { userId } } },
      select: { id: true },
    });
    if (!answerSet) {
      throw new NotFoundException('Answer set not found');
    }

    const updated = await this.prisma.answerSet.update({
      where: { id: answerSetId },
      data: {
        ...data,
        status: AnswerSetStatus.edited,
        reviewedAt: new Date(),
      },
    });
    return toAnswerSetView(updated);
  }
}
