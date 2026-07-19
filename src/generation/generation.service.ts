import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { AnswerSetStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  bankJobKey,
  GENERATE_BANK_JOB,
  GENERATION_QUEUE,
  GenerateBankJobData,
} from './generation.constants';

/** GenerationJob per the OpenAPI schema (POST returns the queued subset). */
export interface GenerationJobView {
  jobId?: string;
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  total: number;
  countsByStatus?: Record<string, number>;
  error?: string;
}

/** Answer-set statuses that need no regeneration (question is playable). */
const READY_STATUSES: AnswerSetStatus[] = [
  AnswerSetStatus.accepted,
  AnswerSetStatus.edited,
];

/** BullMQ job states that count as "generation is still in progress". */
const ACTIVE_JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
];

@Injectable()
export class GenerationService {
  constructor(
    @InjectQueue(GENERATION_QUEUE)
    private readonly queue: Queue<GenerateBankJobData>,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Enqueues one BullMQ job covering every question of the bank that has no
   * accepted/edited answer set. 404 when the bank does not exist or belongs
   * to another host; 409 while a previous job for the bank is still queued
   * or running. An empty bank still gets a job (total 0) - the contract has
   * no other success shape and the worker completes it instantly.
   */
  async startGeneration(
    userId: string,
    bankId: string,
  ): Promise<GenerationJobView> {
    const bank = await this.prisma.bank.findFirst({
      where: { id: bankId, userId },
      include: { questions: { include: { answerSet: true } } },
    });
    if (!bank) {
      throw new NotFoundException('Bank not found');
    }

    if (await this.hasActiveJob(bankId)) {
      throw new ConflictException(
        'Generation for this bank is already running',
      );
    }

    const questionIds = bank.questions
      .filter(
        (question) =>
          !question.answerSet ||
          !READY_STATUSES.includes(question.answerSet.status),
      )
      .map((question) => question.id);

    const job = await this.queue.add(GENERATE_BANK_JOB, {
      bankId,
      questionIds,
    });
    if (job.id) {
      await this.redis.client.set(bankJobKey(bankId), job.id);
    }

    return { jobId: job.id, status: 'queued', total: questionIds.length };
  }

  /** True while the last generation job of the bank is queued or running. */
  private async hasActiveJob(bankId: string): Promise<boolean> {
    const jobId = await this.redis.client.get(bankJobKey(bankId));
    if (!jobId) return false;
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return ACTIVE_JOB_STATES.includes(state);
  }
}
