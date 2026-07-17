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

  describe('GET /api/v1/banks/{bankId}', () => {
    it('200: BankDetailed with questions and host-view answer sets', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Detailed', 3, 2);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const bank = response.body as {
        id: string;
        questionCount: number;
        readyCount: number;
        questions: {
          text: string;
          answerSet?: { correctIndex: number; options: string[] };
        }[];
      };
      expect(bank.id).toBe(seeded.id);
      expect(bank.questionCount).toBe(3);
      expect(bank.readyCount).toBe(2);
      expect(bank.questions).toHaveLength(3);
      expect(bank.questions[0].answerSet?.options).toHaveLength(4);
      expect(bank.questions[2].answerSet).toBeUndefined();
    });

    it('404: foreign bank is indistinguishable from a missing one', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const foreign = prismaMock.seedBank(idA, 'Private', 1, 0);

      const foreignResponse = await request(app.getHttpServer())
        .get(`/api/v1/banks/${foreign.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      const missingResponse = await request(app.getHttpServer())
        .get('/api/v1/banks/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);

      const messageOf = (r: { body: unknown }) =>
        (r.body as { message: string }).message;
      expect(messageOf(foreignResponse)).toBe(messageOf(missingResponse));
    });

    it('400: malformed uuid is rejected', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/banks/not-a-uuid')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(400);
    });

    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/banks/00000000-0000-4000-8000-000000000000')
        .expect(401);
    });
  });

  describe('PATCH /api/v1/banks/{bankId}', () => {
    it('200: renames own bank, counters intact', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Old name', 2, 1);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'New name' })
        .expect(200);

      const bank = response.body as {
        name: string;
        questionCount: number;
        readyCount: number;
      };
      expect(bank.name).toBe('New name');
      expect(bank.questionCount).toBe(2);
      expect(bank.readyCount).toBe(1);
    });

    it('404: foreign bank cannot be renamed', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const foreign = prismaMock.seedBank(idA, 'Keep me', 0, 0);

      await request(app.getHttpServer())
        .patch(`/api/v1/banks/${foreign.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Hacked' })
        .expect(404);
    });

    it('400: empty name is rejected', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Valid', 0, 0);

      await request(app.getHttpServer())
        .patch(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: '' })
        .expect(400);
    });
  });

  describe('DELETE /api/v1/banks/{bankId}', () => {
    it('204: deletes own bank with questions and answer sets (cascade)', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Doomed', 3, 2);
      const before = prismaMock.counts();

      await request(app.getHttpServer())
        .delete(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      const after = prismaMock.counts();
      expect(before.banks - after.banks).toBe(1);
      expect(before.questions - after.questions).toBe(3);
      expect(before.answerSets - after.answerSets).toBe(2);

      await request(app.getHttpServer())
        .get(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it('404: foreign bank cannot be deleted and stays intact', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const foreign = prismaMock.seedBank(idA, 'Protected', 2, 1);
      const before = prismaMock.counts();

      await request(app.getHttpServer())
        .delete(`/api/v1/banks/${foreign.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);

      expect(prismaMock.counts()).toEqual(before);
    });

    it('404: repeated deletion of the same bank', async () => {
      const idA = prismaMock.userIdByEmail(hostA.email);
      const seeded = prismaMock.seedBank(idA, 'Once', 0, 0);

      await request(app.getHttpServer())
        .delete(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/v1/banks/${seeded.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });
});
