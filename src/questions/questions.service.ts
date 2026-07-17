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
}
