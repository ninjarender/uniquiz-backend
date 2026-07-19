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
});
