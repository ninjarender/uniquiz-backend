import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from './questions.service';

describe('QuestionsService', () => {
  let service: QuestionsService;
  const bankFindFirst = jest.fn();
  const questionCreate = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        QuestionsService,
        {
          provide: PrismaService,
          useValue: {
            bank: { findFirst: bankFindFirst },
            question: { create: questionCreate },
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
});
