import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from './questions.service';

describe('QuestionsService', () => {
  let service: QuestionsService;
  const bankFindFirst = jest.fn();
  const questionCreate = jest.fn();
  const questionUpdateMany = jest.fn();
  const questionFindUnique = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        QuestionsService,
        {
          provide: PrismaService,
          useValue: {
            bank: { findFirst: bankFindFirst },
            question: {
              create: questionCreate,
              updateMany: questionUpdateMany,
              findUnique: questionFindUnique,
            },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(QuestionsService);
  });

  describe('createQuestion', () => {
    it('404 when the bank is missing or foreign', async () => {
      bankFindFirst.mockResolvedValue(null);

      await expect(
        service.createQuestion('host-1', 'bank-x', { text: 'Q?' }),
      ).rejects.toThrow(NotFoundException);
      expect(questionCreate).not.toHaveBeenCalled();
    });

    it('creates a question in an own bank (minimal body)', async () => {
      bankFindFirst.mockResolvedValue({ id: 'bank-a' });
      questionCreate.mockResolvedValue({
        id: 'q-1',
        bankId: 'bank-a',
        text: 'Apple?',
        imageUrl: null,
        referenceAnswer: null,
      });

      await expect(
        service.createQuestion('host-1', 'bank-a', { text: 'Apple?' }),
      ).resolves.toEqual({ id: 'q-1', bankId: 'bank-a', text: 'Apple?' });
    });

    it('creates a question with image and reference answer (full body)', async () => {
      bankFindFirst.mockResolvedValue({ id: 'bank-a' });
      questionCreate.mockResolvedValue({
        id: 'q-2',
        bankId: 'bank-a',
        text: 'Pear?',
        imageUrl: 'https://img/p.png',
        referenceAnswer: 'fruit',
      });

      await expect(
        service.createQuestion('host-1', 'bank-a', {
          text: 'Pear?',
          imageUrl: 'https://img/p.png',
          referenceAnswer: 'fruit',
        }),
      ).resolves.toEqual({
        id: 'q-2',
        bankId: 'bank-a',
        text: 'Pear?',
        imageUrl: 'https://img/p.png',
        referenceAnswer: 'fruit',
      });
      expect(questionCreate).toHaveBeenCalledWith({
        data: {
          bankId: 'bank-a',
          text: 'Pear?',
          imageUrl: 'https://img/p.png',
          referenceAnswer: 'fruit',
        },
      });
    });
  });

  describe('updateQuestion', () => {
    it('404 when the question is missing or foreign', async () => {
      questionUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateQuestion('host-1', 'q-x', { text: 'New' }),
      ).rejects.toThrow(NotFoundException);
      expect(questionUpdateMany).toHaveBeenCalledWith({
        where: { id: 'q-x', bank: { userId: 'host-1' } },
        data: { text: 'New', imageUrl: undefined, referenceAnswer: undefined },
      });
    });

    it('edits the text and does NOT touch the existing answer set', async () => {
      questionUpdateMany.mockResolvedValue({ count: 1 });
      const existingSet = {
        id: 'set-1',
        questionId: 'q-1',
        options: ['a', 'b', 'c', 'd'],
        correctIndex: 0,
        spareDistractor: 'e',
        explanation: 'why',
        status: 'accepted',
        selfCheckPassed: true,
        generatedAt: new Date(),
        reviewedAt: null,
      };
      questionFindUnique.mockResolvedValue({
        id: 'q-1',
        bankId: 'bank-a',
        text: 'Edited text',
        imageUrl: null,
        referenceAnswer: null,
        answerSet: existingSet,
      });

      const question = await service.updateQuestion('host-1', 'q-1', {
        text: 'Edited text',
      });

      expect(question.text).toBe('Edited text');
      expect(question.answerSet?.id).toBe('set-1');
      expect(question.answerSet?.status).toBe('accepted'); // untouched
    });
  });
});
