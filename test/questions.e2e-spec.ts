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
});
