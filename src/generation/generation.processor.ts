import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from './gemini.service';
import {
  GENERATE_BANK_JOB,
  GENERATION_QUEUE,
  GenerateBankJobData,
  MAX_SET_ATTEMPTS,
  REGENERATE_SET_JOB,
  RegenerateSetJobData,
} from './generation.constants';

/** Validated AI output, ready to be stored on the answer set. */
interface GeneratedContent {
  options: string[];
  correctIndex: number;
  spareDistractor: string;
  explanation: string;
}

/** Statuses meaning "this question needs no generation anymore". */
const DONE_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.in_review,
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

/** Runs items through fn with at most `limit` concurrent executions. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * BullMQ consumer of the generation queue. A bank job fans out into
 * per-question pipelines (bounded concurrency); a regenerate job runs the
 * same pipeline for one set. Failed job attempts are retried by BullMQ with
 * backoff (queue defaults); an exhausted job surfaces its error through
 * GET /banks/{bankId}/generation.
 */
@Injectable()
@Processor(GENERATION_QUEUE)
export class GenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationProcessor.name);
  private readonly concurrency: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
    config: ConfigService,
  ) {
    super();
    this.concurrency = config.get<number>('GENERATION_CONCURRENCY', 5);
  }

  async process(job: Job): Promise<void> {
    if (job.name === GENERATE_BANK_JOB) {
      return this.processBank(job.data as GenerateBankJobData);
    }
    if (job.name === REGENERATE_SET_JOB) {
      const { questionId } = job.data as RegenerateSetJobData;
      return this.processQuestion(questionId);
    }
    this.logger.warn(`Unknown job ${job.name}, skipping`);
  }

  /**
   * Fans a bank job out into per-question pipelines. Questions whose set is
   * already reviewed (in_review/accepted/edited) are skipped, which makes a
   * retried job attempt resume where the previous one stopped. Per-question
   * failures do not abort the rest; if any remain, the attempt throws so
   * BullMQ retries and, once attempts are exhausted, the job is failed with
   * this error for the status endpoint.
   */
  private async processBank(data: GenerateBankJobData): Promise<void> {
    const failed: string[] = [];
    await mapWithConcurrency(
      data.questionIds,
      this.concurrency,
      async (questionId) => {
        try {
          await this.processQuestion(questionId, { skipDone: true });
        } catch (error) {
          failed.push(questionId);
          this.logger.error(
            `Generation failed for question ${questionId}: ${String(error)}`,
          );
        }
      },
    );
    if (failed.length > 0) {
      throw new Error(
        `Generation failed for ${failed.length} of ${data.questionIds.length} questions`,
      );
    }
  }

  /**
   * Pipeline of one answer set: placeholder in `generating` → Gemini call
   * (distractors-only when the question has a reference answer) → formal
   * validation → `self_check` by the second model → `in_review`.
   *
   * Invalid AI output is retried up to MAX_SET_ATTEMPTS, then the question
   * counts as failed. A failed self-check regenerates the set; when attempts
   * run out with valid content, the set still reaches in_review with
   * selfCheckPassed: false - the host review is the final safety net.
   * API errors propagate to the BullMQ retry mechanism.
   */
  private async processQuestion(
    questionId: string,
    { skipDone = false }: { skipDone?: boolean } = {},
  ): Promise<void> {
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      include: { answerSet: true },
    });
    if (!question) {
      throw new Error(`Question ${questionId} not found`);
    }
    if (
      skipDone &&
      question.answerSet &&
      DONE_STATUSES.includes(question.answerSet.status)
    ) {
      return;
    }

    await this.prisma.answerSet.upsert({
      where: { questionId },
      create: {
        questionId,
        options: ['', '', '', ''],
        correctIndex: 0,
        spareDistractor: '',
        explanation: '',
        status: AnswerSetStatus.generating,
        selfCheckPassed: false,
        generatedAt: new Date(),
      },
      update: { status: AnswerSetStatus.generating },
    });

    for (let attempt = 1; attempt <= MAX_SET_ATTEMPTS; attempt++) {
      const content = await this.generateContent(question);
      if (!content) continue;

      await this.prisma.answerSet.update({
        where: { questionId },
        data: {
          options: content.options,
          correctIndex: content.correctIndex,
          spareDistractor: content.spareDistractor,
          explanation: content.explanation,
          status: AnswerSetStatus.self_check,
          selfCheckPassed: false,
          generatedAt: new Date(),
          reviewedAt: null,
        },
      });

      const passed = await this.selfCheck(question.text, content);
      if (!passed && attempt < MAX_SET_ATTEMPTS) continue;

      await this.prisma.answerSet.update({
        where: { questionId },
        data: { status: AnswerSetStatus.in_review, selfCheckPassed: passed },
      });
      return;
    }

    throw new Error(
      `AI returned invalid output for question ${questionId} ${MAX_SET_ATTEMPTS} times`,
    );
  }

  /** One Gemini call, formally validated; null means "retry". */
  private async generateContent(question: {
    text: string;
    referenceAnswer: string | null;
  }): Promise<GeneratedContent | null> {
    if (question.referenceAnswer) {
      const raw = (await this.gemini.generateDistractors(
        question.text,
        question.referenceAnswer,
      )) as Partial<{
        distractors: unknown;
        spareDistractor: unknown;
        explanation: unknown;
      }>;
      if (
        !isStringArray(raw.distractors, 3) ||
        !isNonEmptyString(raw.spareDistractor) ||
        !isNonEmptyString(raw.explanation)
      ) {
        return null;
      }
      // The server, not the model, decides where the reference answer sits.
      const correctIndex = Math.floor(Math.random() * 4);
      const options = [...raw.distractors];
      options.splice(correctIndex, 0, question.referenceAnswer);
      return {
        options,
        correctIndex,
        spareDistractor: raw.spareDistractor,
        explanation: raw.explanation,
      };
    }

    const raw = (await this.gemini.generateFullSet(question.text)) as Partial<{
      options: unknown;
      correctIndex: unknown;
      spareDistractor: unknown;
      explanation: unknown;
    }>;
    if (
      !isStringArray(raw.options, 4) ||
      !isValidIndex(raw.correctIndex) ||
      !isNonEmptyString(raw.spareDistractor) ||
      !isNonEmptyString(raw.explanation)
    ) {
      return null;
    }
    return {
      options: raw.options,
      correctIndex: raw.correctIndex,
      spareDistractor: raw.spareDistractor,
      explanation: raw.explanation,
    };
  }

  /** Second-model check: does its blind pick match our correct index? */
  private async selfCheck(
    questionText: string,
    content: GeneratedContent,
  ): Promise<boolean> {
    const raw = (await this.gemini.pickCorrectOption(
      questionText,
      content.options,
    )) as Partial<{ correctIndex: unknown }>;
    return (
      isValidIndex(raw.correctIndex) &&
      raw.correctIndex === content.correctIndex
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(isNonEmptyString)
  );
}

function isValidIndex(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3
  );
}
