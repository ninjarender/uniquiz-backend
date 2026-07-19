import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { GeminiService } from './gemini.service';
import { GenerationProcessor } from './generation.processor';
import { PrismaService } from '../prisma/prisma.service';

type StoredSet = {
  questionId: string;
  options: string[];
  correctIndex: number;
  spareDistractor: string;
  explanation: string;
  status: string;
  selfCheckPassed: boolean;
};

type StoredQuestion = {
  id: string;
  text: string;
  referenceAnswer: string | null;
};

/** Minimal in-memory Prisma stand-in for the two models the worker touches. */
class WorkerPrismaMock {
  readonly questions = new Map<string, StoredQuestion>();
  readonly sets = new Map<string, StoredSet>();
  /** status values written per question, in order (lifecycle assertions). */
  readonly statusLog = new Map<string, string[]>();

  question = {
    findUnique: ({ where }: { where: { id: string } }) => {
      const question = this.questions.get(where.id);
      if (!question) return Promise.resolve(null);
      return Promise.resolve({
        ...question,
        answerSet: this.sets.get(question.id) ?? null,
      });
    },
  };

  answerSet = {
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { questionId: string };
      create: StoredSet;
      update: Partial<StoredSet>;
    }) => {
      const existing = this.sets.get(where.questionId);
      const next = existing ? { ...existing, ...update } : { ...create };
      this.sets.set(where.questionId, next);
      this.log(where.questionId, next.status);
      return Promise.resolve({ ...next });
    },
    update: ({
      where,
      data,
    }: {
      where: { questionId: string };
      data: Partial<StoredSet>;
    }) => {
      const existing = this.sets.get(where.questionId);
      if (!existing) return Promise.reject(new Error('no set'));
      Object.assign(existing, data);
      if (typeof data.status === 'string') {
        this.log(where.questionId, data.status);
      }
      return Promise.resolve({ ...existing });
    },
  };

  seedQuestion(id: string, referenceAnswer: string | null = null): void {
    this.questions.set(id, { id, text: `Question ${id}`, referenceAnswer });
  }

  private log(questionId: string, status: string): void {
    const entries = this.statusLog.get(questionId) ?? [];
    entries.push(status);
    this.statusLog.set(questionId, entries);
  }
}

const VALID_FULL_SET = {
  options: ['Kyiv', 'Lviv', 'Odesa', 'Dnipro'],
  correctIndex: 0,
  spareDistractor: 'Kharkiv',
  explanation: 'Kyiv is the capital',
};

function bankJob(questionIds: string[]): Job {
  return {
    name: 'generate-bank',
    data: { bankId: 'bank-1', questionIds },
  } as unknown as Job;
}

function regenerateJob(questionId: string): Job {
  return {
    name: 'regenerate-set',
    data: { answerSetId: 'set-1', questionId },
  } as unknown as Job;
}

describe('GenerationProcessor', () => {
  let prisma: WorkerPrismaMock;
  let gemini: {
    generateFullSet: jest.Mock;
    generateDistractors: jest.Mock;
    pickCorrectOption: jest.Mock;
  };
  let processor: GenerationProcessor;

  beforeEach(() => {
    prisma = new WorkerPrismaMock();
    gemini = {
      generateFullSet: jest.fn(),
      generateDistractors: jest.fn(),
      pickCorrectOption: jest.fn(),
    };
    processor = new GenerationProcessor(
      prisma as unknown as PrismaService,
      gemini as unknown as GeminiService,
      new ConfigService(),
    );
  });

  it('happy path: full set reaches in_review with selfCheckPassed', async () => {
    prisma.seedQuestion('q1');
    gemini.generateFullSet.mockResolvedValue(VALID_FULL_SET);
    gemini.pickCorrectOption.mockResolvedValue({ correctIndex: 0 });

    await processor.process(bankJob(['q1']));

    const set = prisma.sets.get('q1');
    expect(set?.status).toBe('in_review');
    expect(set?.selfCheckPassed).toBe(true);
    expect(set?.options).toEqual(VALID_FULL_SET.options);
    expect(set?.spareDistractor).toBe('Kharkiv');
    expect(prisma.statusLog.get('q1')).toEqual([
      'generating',
      'self_check',
      'in_review',
    ]);
  });

  it('reference answer: distractors mode, server places the answer', async () => {
    prisma.seedQuestion('q2', 'Kyiv');
    gemini.generateDistractors.mockResolvedValue({
      distractors: ['Lviv', 'Odesa', 'Dnipro'],
      spareDistractor: 'Kharkiv',
      explanation: 'Kyiv is the capital',
    });
    gemini.pickCorrectOption.mockImplementation(
      (_text: string, options: string[]) =>
        Promise.resolve({ correctIndex: options.indexOf('Kyiv') }),
    );

    await processor.process(regenerateJob('q2'));

    const set = prisma.sets.get('q2');
    if (!set) throw new Error('set q2 missing');
    expect(gemini.generateFullSet).not.toHaveBeenCalled();
    expect(set.status).toBe('in_review');
    expect(set.selfCheckPassed).toBe(true);
    expect(set.options).toHaveLength(4);
    expect(set.options).toContain('Kyiv');
    expect(set.options[set.correctIndex]).toBe('Kyiv');
  });

  it('invalid output: retries, then succeeds', async () => {
    prisma.seedQuestion('q3');
    gemini.generateFullSet
      .mockResolvedValueOnce({ options: ['only', 'three', 'items'] })
      .mockResolvedValueOnce(VALID_FULL_SET);
    gemini.pickCorrectOption.mockResolvedValue({ correctIndex: 0 });

    await processor.process(bankJob(['q3']));

    expect(gemini.generateFullSet).toHaveBeenCalledTimes(2);
    expect(prisma.sets.get('q3')?.status).toBe('in_review');
  });

  it('invalid output 3 times: the job attempt fails', async () => {
    prisma.seedQuestion('q4');
    gemini.generateFullSet.mockResolvedValue({ nonsense: true });

    await expect(processor.process(bankJob(['q4']))).rejects.toThrow(
      'Generation failed for 1 of 1 questions',
    );
    expect(gemini.generateFullSet).toHaveBeenCalledTimes(3);
    expect(prisma.sets.get('q4')?.status).toBe('generating');
  });

  it('failed self-check: regenerates, exhausted attempts end in_review with selfCheckPassed=false', async () => {
    prisma.seedQuestion('q5');
    gemini.generateFullSet.mockResolvedValue(VALID_FULL_SET);
    gemini.pickCorrectOption.mockResolvedValue({ correctIndex: 2 });

    await processor.process(bankJob(['q5']));

    const set = prisma.sets.get('q5');
    expect(gemini.generateFullSet).toHaveBeenCalledTimes(3);
    expect(set?.status).toBe('in_review');
    expect(set?.selfCheckPassed).toBe(false);
  });

  it('API failure propagates so BullMQ can retry the job', async () => {
    prisma.seedQuestion('q6');
    gemini.generateFullSet.mockRejectedValue(new Error('quota exceeded'));

    await expect(processor.process(regenerateJob('q6'))).rejects.toThrow(
      'quota exceeded',
    );
  });

  it('partial failure: healthy questions finish, the job still fails', async () => {
    prisma.seedQuestion('ok');
    prisma.seedQuestion('bad');
    gemini.generateFullSet.mockImplementation((text: string) =>
      text.includes('bad')
        ? Promise.resolve({ nonsense: true })
        : Promise.resolve(VALID_FULL_SET),
    );
    gemini.pickCorrectOption.mockResolvedValue({ correctIndex: 0 });

    await expect(processor.process(bankJob(['ok', 'bad']))).rejects.toThrow(
      'Generation failed for 1 of 2 questions',
    );
    expect(prisma.sets.get('ok')?.status).toBe('in_review');
  });

  it('retried bank job skips questions that are already reviewed', async () => {
    prisma.seedQuestion('done');
    prisma.sets.set('done', {
      questionId: 'done',
      options: ['A', 'B', 'C', 'D'],
      correctIndex: 0,
      spareDistractor: 'E',
      explanation: 'why',
      status: 'in_review',
      selfCheckPassed: true,
    });

    await processor.process(bankJob(['done']));

    expect(gemini.generateFullSet).not.toHaveBeenCalled();
    expect(prisma.sets.get('done')?.status).toBe('in_review');
  });
});
