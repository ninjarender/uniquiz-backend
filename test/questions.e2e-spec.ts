import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaMock } from './prisma.mock';

describe('Questions endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: PrismaMock;
  let tokenA: string;
  let tokenB: string;
  let bankAId: string;
  const hostA = { email: 'host-a@example.com', password: 'password123' };
  const hostB = { email: 'host-b@example.com', password: 'password123' };

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

    const bank = await request(app.getHttpServer())
      .post('/api/v1/banks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Bank A' })
      .expect(201);
    bankAId = (bank.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/banks/{bankId}/questions', () => {
    it('201: minimal body creates a question without an answer set', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/banks/${bankAId}/questions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ text: 'What is an apple?' })
        .expect(201);

      const question = response.body as {
        id: string;
        bankId: string;
        text: string;
        answerSet?: unknown;
      };
      expect(typeof question.id).toBe('string');
      expect(question.bankId).toBe(bankAId);
      expect(question.text).toBe('What is an apple?');
      expect(question.answerSet).toBeUndefined();
    });

    it('201: full body keeps imageUrl and referenceAnswer', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/banks/${bankAId}/questions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          text: 'What is a pear?',
          imageUrl: 'https://cdn.example.com/pear.png',
          referenceAnswer: 'A fruit',
        })
        .expect(201);

      const question = response.body as {
        imageUrl?: string;
        referenceAnswer?: string;
      };
      expect(question.imageUrl).toBe('https://cdn.example.com/pear.png');
      expect(question.referenceAnswer).toBe('A fruit');
    });

    it('404: foreign bank rejects question creation', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bankAId}/questions`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ text: 'Sneaky question' })
        .expect(404);
    });

    it('400: missing text is rejected', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bankAId}/questions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ imageUrl: 'https://cdn.example.com/x.png' })
        .expect(400);
    });

    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/banks/${bankAId}/questions`)
        .send({ text: 'No token' })
        .expect(401);
    });
  });

  describe('PATCH /api/v1/questions/{questionId}', () => {
    it('200: edits text; the existing answer set stays untouched', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'With sets', 2, 2);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ text: 'Edited question text' })
        .expect(200);

      const question = response.body as {
        text: string;
        answerSet?: { status: string; options: string[] };
      };
      expect(question.text).toBe('Edited question text');
      expect(question.answerSet?.status).toBe('accepted'); // not reset
      expect(question.answerSet?.options).toHaveLength(4);
    });

    it('200: empty body is a valid no-op', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Noop QA', 1, 0);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);

      expect((response.body as { text: string }).text).toBe('Question 1');
    });

    it('404: foreign question cannot be edited', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Private QA', 1, 0);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);

      await request(app.getHttpServer())
        .patch(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ text: 'Hacked' })
        .expect(404);
    });

    it('400: empty text is rejected', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Valid QA', 1, 0);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);

      await request(app.getHttpServer())
        .patch(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ text: '' })
        .expect(400);
    });
  });

  describe('DELETE /api/v1/questions/{questionId}', () => {
    it('204: deletes a question with its answer set', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Del QA', 2, 1);
      const [withSet, withoutSet] = prismaMock.questionIdsOf(seeded.id);
      const before = prismaMock.counts();

      await request(app.getHttpServer())
        .delete(`/api/v1/questions/${withSet}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      let after = prismaMock.counts();
      expect(before.questions - after.questions).toBe(1);
      expect(before.answerSets - after.answerSets).toBe(1);

      await request(app.getHttpServer())
        .delete(`/api/v1/questions/${withoutSet}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      after = prismaMock.counts();
      expect(before.questions - after.questions).toBe(2);
      expect(before.answerSets - after.answerSets).toBe(1);
    });

    it('404: foreign question cannot be deleted', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Safe QA', 1, 1);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);
      const before = prismaMock.counts();

      await request(app.getHttpServer())
        .delete(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);

      expect(prismaMock.counts()).toEqual(before);
    });

    it('404: repeated deletion', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Once QA', 1, 0);
      const [questionId] = prismaMock.questionIdsOf(seeded.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/v1/questions/${questionId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });
});
