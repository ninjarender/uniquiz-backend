import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaMock } from './prisma.mock';

describe('Banks endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: PrismaMock;
  let tokenA: string;
  let tokenB: string;
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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/banks', () => {
    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer()).get('/api/v1/banks').expect(401);
    });

    it('200: returns Bank[] with DB-computed counters, newest first', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      prismaMock.seedBank(idA, 'Lexis', 5, 3);
      prismaMock.seedBank(idA, 'Grammar', 2, 0);

      const response = await request(app.getHttpServer())
        .get('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const banks = response.body as {
        name: string;
        questionCount: number;
        readyCount: number;
      }[];
      expect(banks).toHaveLength(2);
      expect(banks[0].name).toBe('Grammar'); // newest first
      expect(banks[0].questionCount).toBe(2);
      expect(banks[0].readyCount).toBe(0);
      expect(banks[1].name).toBe('Lexis');
      expect(banks[1].questionCount).toBe(5);
      expect(banks[1].readyCount).toBe(3);
    });

    it('200: another host sees an empty list (isolation)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/v1/banks', () => {
    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/banks')
        .send({ name: 'New bank' })
        .expect(401);
    });

    it('201: creates a bank with zero counters (Bank schema)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Biology' })
        .expect(201);

      const bank = response.body as {
        id: string;
        name: string;
        questionCount: number;
        readyCount: number;
      };
      expect(typeof bank.id).toBe('string');
      expect(bank.name).toBe('Biology');
      expect(bank.questionCount).toBe(0);
      expect(bank.readyCount).toBe(0);

      const list = await request(app.getHttpServer())
        .get('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect((list.body as { id: string }[]).map((b) => b.id)).toContain(
        bank.id,
      );
    });

    it.each([
      ['empty name', { name: '' }],
      ['missing name', {}],
      ['non-string name', { name: 42 }],
    ])('400: %s is rejected', async (_name, payload) => {
      await request(app.getHttpServer())
        .post('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send(payload)
        .expect(400);
    });
  });
});
