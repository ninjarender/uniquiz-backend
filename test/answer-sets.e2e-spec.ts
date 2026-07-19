import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaMock } from './prisma.mock';

describe('Answer-set endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: PrismaMock;
  let tokenA: string;
  let tokenB: string;
  const hostA = { email: 'sets-a@example.com', password: 'password123' };
  const hostB = { email: 'sets-b@example.com', password: 'password123' };

  /** A fresh bank of host A with one question and a set in the status. */
  function seedSet(status: string): { id: string } {
    const idA = prismaMock.userIdByEmail(hostA.email);
    const bank = prismaMock.seedBank(idA, `Bank-${status}`, 1, 0);
    const [questionId] = prismaMock.questionIdsOf(bank.id);
    return prismaMock.seedAnswerSet(questionId, status);
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-secret';

    prismaMock = new PrismaMock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
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

  describe('POST /api/v1/answer-sets/{answerSetId}/accept', () => {
    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${randomUUID()}/accept`)
        .expect(401);
    });

    it('404: unknown answer set', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${randomUUID()}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it("404: another host's answer set looks missing", async () => {
      const set = seedSet('in_review');

      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${set.id}/accept`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('200: accepts an in_review set and stamps reviewedAt', async () => {
      const set = seedSet('in_review');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${set.id}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const body = response.body as {
        id: string;
        status: string;
        reviewedAt?: string;
        correctIndex: number;
        options: string[];
      };
      expect(body.id).toBe(set.id);
      expect(body.status).toBe('accepted');
      expect(body.reviewedAt).toBeDefined();
      expect(body.options).toEqual(['A', 'B', 'C', 'D']);
      expect(body.correctIndex).toBe(1);
    });

    it('409: repeated accept of an already accepted set', async () => {
      const set = seedSet('in_review');

      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${set.id}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${set.id}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
    });

    it('409: a set still generating cannot be accepted', async () => {
      const set = seedSet('generating');

      await request(app.getHttpServer())
        .post(`/api/v1/answer-sets/${set.id}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
    });
  });

  describe('PATCH /api/v1/answer-sets/{answerSetId}', () => {
    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${randomUUID()}`)
        .send({ explanation: 'x' })
        .expect(401);
    });

    it('404: unknown answer set', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ explanation: 'x' })
        .expect(404);
    });

    it("404: another host's answer set looks missing", async () => {
      const set = seedSet('in_review');

      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ explanation: 'x' })
        .expect(404);
    });

    it('200: edits options and correct index, set becomes edited', async () => {
      const set = seedSet('in_review');

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ options: ['W', 'X', 'Y', 'Z'], correctIndex: 3 })
        .expect(200);

      const body = response.body as {
        options: string[];
        correctIndex: number;
        status: string;
        reviewedAt?: string;
      };
      expect(body.options).toEqual(['W', 'X', 'Y', 'Z']);
      expect(body.correctIndex).toBe(3);
      expect(body.status).toBe('edited');
      expect(body.reviewedAt).toBeDefined();
    });

    it('200: edits explanation and spare distractor', async () => {
      const set = seedSet('in_review');

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ explanation: 'better why', spareDistractor: 'F' })
        .expect(200);

      const body = response.body as {
        explanation: string;
        spareDistractor: string;
        status: string;
      };
      expect(body.explanation).toBe('better why');
      expect(body.spareDistractor).toBe('F');
      expect(body.status).toBe('edited');
    });

    it('200: an already accepted set can still be edited', async () => {
      const set = seedSet('accepted');

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ correctIndex: 0 })
        .expect(200);

      expect((response.body as { status: string }).status).toBe('edited');
    });

    it('400: empty body (minProperties: 1)', async () => {
      const set = seedSet('in_review');

      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(400);
    });

    it('400: options must be exactly 4', async () => {
      const set = seedSet('in_review');

      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ options: ['only', 'three', 'items'] })
        .expect(400);

      await request(app.getHttpServer())
        .patch(`/api/v1/answer-sets/${set.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ correctIndex: 4 })
        .expect(400);
    });
  });
});
