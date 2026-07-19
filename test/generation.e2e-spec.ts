import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { GenerateBankJobData } from '../src/generation/generation.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { PrismaMock } from './prisma.mock';

type MockJob = {
  id: string;
  name: string;
  data: GenerateBankJobData;
  state: string;
  getState(): Promise<string>;
};

/** In-memory stand-in for the BullMQ generation queue. */
class QueueMock {
  readonly added: MockJob[] = [];
  private sequence = 0;

  add(name: string, data: GenerateBankJobData): Promise<MockJob> {
    const job: MockJob = {
      id: `job-${++this.sequence}`,
      name,
      data,
      state: 'waiting',
      getState: () => Promise.resolve(job.state),
    };
    this.added.push(job);
    return Promise.resolve(job);
  }

  getJob(id: string): Promise<MockJob | undefined> {
    return Promise.resolve(this.added.find((job) => job.id === id));
  }

  last(): MockJob {
    const job = this.added.at(-1);
    if (!job) throw new Error('no jobs enqueued');
    return job;
  }
}

/** In-memory stand-in for RedisService (only get/set are used). */
class RedisMock {
  private readonly store = new Map<string, string>();
  readonly client = {
    get: (key: string) => Promise.resolve(this.store.get(key) ?? null),
    set: (key: string, value: string) => {
      this.store.set(key, value);
      return Promise.resolve('OK');
    },
  };
}

describe('Generation endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: PrismaMock;
  let queueMock: QueueMock;
  let tokenA: string;
  let tokenB: string;
  const hostA = { email: 'gen-a@example.com', password: 'password123' };
  const hostB = { email: 'gen-b@example.com', password: 'password123' };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-secret';

    prismaMock = new PrismaMock();
    queueMock = new QueueMock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(RedisService)
      .useValue(new RedisMock())
      .overrideProvider(getQueueToken('generation'))
      .useValue(queueMock)
      .compile();

    app = setupApp(moduleRef.createNestApplication<INestApplication<App>>());
    await app.init();

    const [responseA, responseB] = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/auth/register').send(hostA),
      request(app.getHttpServer()).post('/api/v1/auth/register').send(hostB),
    ]);
    tokenA = (responseA.body as { accessToken: string }).accessToken;
    tokenB = (responseB.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/banks/{bankId}/generation', () => {
    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${randomUUID()}/generation`)
        .expect(401);
    });

    it('404: unknown bank', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${randomUUID()}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it("404: another host's bank looks missing", async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const bank = prismaMock.seedBank(idA, 'Foreign', 1, 0);

      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('202: enqueues one job covering only questions without a ready set', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const bank = prismaMock.seedBank(idA, 'Lexis', 5, 3);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(202);

      const job = queueMock.last();
      expect(response.body).toEqual({
        jobId: job.id,
        status: 'queued',
        total: 2,
      });
      expect(job.name).toBe('generate-bank');
      expect(job.data.bankId).toBe(bank.id);
      // seedBank marks the first 3 of 5 questions ready → the last 2 pend.
      expect(job.data.questionIds).toEqual(
        prismaMock.questionIdsOf(bank.id).slice(3),
      );
    });

    it('409: repeated call while the job is still queued or running', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const bank = prismaMock.seedBank(idA, 'Grammar', 2, 0);

      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(202);

      queueMock.last().state = 'active';
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
    });

    it('202: a finished job does not block a new run', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const bank = prismaMock.seedBank(idA, 'History', 1, 0);

      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(202);

      queueMock.last().state = 'completed';
      const response = await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(202);

      expect((response.body as { jobId: string }).jobId).toBe(
        queueMock.last().id,
      );
    });

    it('202: a bank without questions gets an empty job (total 0)', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const bank = prismaMock.seedBank(idA, 'Empty', 0, 0);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/banks/${bank.id}/generation`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(202);

      expect(response.body).toEqual({
        jobId: queueMock.last().id,
        status: 'queued',
        total: 0,
      });
      expect(queueMock.last().data.questionIds).toEqual([]);
    });
  });
});
