import { Injectable, NotFoundException } from '@nestjs/common';
import { QuestionView } from '../banks/banks.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question-input.dto';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Adds a question to the host's own bank; 404 for a missing/foreign bank
   * (same error). Returns the Question schema without an answer set.
   */
  async createQuestion(
    userId: string,
    bankId: string,
    input: CreateQuestionDto,
  ): Promise<QuestionView> {
    const bank = await this.prisma.bank.findFirst({
      where: { id: bankId, userId },
      select: { id: true },
    });
    if (!bank) {
      throw new NotFoundException('Bank not found');
    }

    const question = await this.prisma.question.create({
      data: {
        bankId,
        text: input.text,
        imageUrl: input.imageUrl,
        referenceAnswer: input.referenceAnswer,
      },
    });
    return {
      id: question.id,
      bankId: question.bankId,
      text: question.text,
      imageUrl: question.imageUrl ?? undefined,
      referenceAnswer: question.referenceAnswer ?? undefined,
    };
  }

  /**
   * Edits the host's own question. By contract the edit never touches an
   * existing answer set - regeneration is a separate host action
   * (POST /answer-sets/{id}/regenerate). 404 for foreign/missing.
   */
  async updateQuestion(
    userId: string,
    questionId: string,
    input: UpdateQuestionDto,
  ): Promise<QuestionView> {
    const hasChanges =
      input.text !== undefined ||
      input.imageUrl !== undefined ||
      input.referenceAnswer !== undefined;

    if (hasChanges) {
      const { count } = await this.prisma.question.updateMany({
        where: { id: questionId, bank: { userId } },
        data: {
          text: input.text,
          imageUrl: input.imageUrl,
          referenceAnswer: input.referenceAnswer,
        },
      });
      if (count === 0) {
        throw new NotFoundException('Question not found');
      }
    } else {
      // Empty PATCH: a valid no-op, but ownership must still be enforced.
      const owned = await this.prisma.question.findFirst({
        where: { id: questionId, bank: { userId } },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException('Question not found');
      }
    }

    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      include: { answerSet: true },
    });
    if (!question) {
      throw new NotFoundException('Question not found');
    }
    return {
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
    };
  }
}
