import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type StoredUser = { id: string; email: string; passwordHash: string };
type StoredBank = {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};
type StoredQuestion = { id: string; bankId: string; answerSetStatus?: string };

/**
 * In-memory PrismaService stand-in: emulates the users table with its
 * unique-email constraint (rejects with code P2002, like PostgreSQL + Prisma).
 */
class PrismaMock {
  private readonly usersByEmail = new Map<string, StoredUser>();

  private readonly banks: StoredBank[] = [];
  private readonly questions: StoredQuestion[] = [];

  /** Test seeding helper: a bank with N questions, M of them ready. */
  seedBank(
    userId: string,
    name: string,
    questionCount: number,
    readyCount: number,
  ): StoredBank {
    const bank: StoredBank = {
      id: `bank-${this.banks.length + 1}`,
      userId,
      name,
      createdAt: new Date(Date.now() + this.banks.length * 1000),
      updatedAt: new Date(),
    };
    this.banks.push(bank);
    for (let i = 0; i < questionCount; i++) {
      this.questions.push({
        id: `q-${bank.id}-${i}`,
        bankId: bank.id,
        answerSetStatus: i < readyCount ? 'accepted' : undefined,
      });
    }
    return bank;
  }

  /** id of a registered user, for seeding. */
  userIdByEmail(email: string): string {
    const user = this.usersByEmail.get(email);
    if (!user) throw new Error(`no user ${email}`);
    return user.id;
  }

  bank = {
    findMany: ({ where }: { where: { userId: string } }) => {
      const rows = this.banks
        .filter((bank) => bank.userId === where.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((bank) => ({
          ...bank,
          _count: {
            questions: this.questions.filter((q) => q.bankId === bank.id)
              .length,
          },
        }));
      return Promise.resolve(rows);
    },
  };

  question = {
    groupBy: ({
      where,
    }: {
      where: {
        bank: { userId: string };
        answerSet: { status: { in: string[] } };
      };
    }) => {
      const bankIds = new Set(
        this.banks
          .filter((bank) => bank.userId === where.bank.userId)
          .map((bank) => bank.id),
      );
      const counts = new Map<string, number>();
      for (const question of this.questions) {
        if (!bankIds.has(question.bankId)) continue;
        if (
          question.answerSetStatus === undefined ||
          !where.answerSet.status.in.includes(question.answerSetStatus)
        )
          continue;
        counts.set(question.bankId, (counts.get(question.bankId) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts.entries()].map(([bankId, count]) => ({
          bankId,
          _count: { _all: count },
        })),
      );
    },
  };

  user = {
    create: ({ data }: { data: { email: string; passwordHash: string } }) => {
      if (this.usersByEmail.has(data.email)) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed on email'), {
            code: 'P2002',
          }),
        );
      }
      const user: StoredUser = {
        id: `user-${this.usersByEmail.size + 1}`,
        email: data.email,
        passwordHash: data.passwordHash,
      };
      this.usersByEmail.set(data.email, user);
      return Promise.resolve({ id: user.id, email: user.email });
    },
    findUnique: ({
      where,
      select,
    }: {
      where: { email?: string; id?: string };
      select?: Partial<Record<keyof StoredUser, boolean>>;
    }) => {
      const user =
        where.email !== undefined
          ? this.usersByEmail.get(where.email)
          : [...this.usersByEmail.values()].find((u) => u.id === where.id);
      if (!user) return Promise.resolve(null);
      if (!select) return Promise.resolve({ ...user });
      const projected: Partial<StoredUser> = {};
      for (const key of Object.keys(select) as (keyof StoredUser)[]) {
        if (select[key]) projected[key] = user[key];
      }
      return Promise.resolve(projected);
    },
  };
}

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: PrismaMock;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-secret';

    prismaMock = new PrismaMock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = setupApp(moduleRef.createNestApplication<INestApplication<App>>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/register', () => {
    it('201: registers a host and returns an AuthToken', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'host@example.com', password: 'password123' })
        .expect(201);

      const body = response.body as { accessToken: string };
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.split('.')).toHaveLength(3); // JWT shape
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('409: duplicate email matches the Error schema', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'dup@example.com', password: 'password123' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'dup@example.com', password: 'another-password' })
        .expect(409);

      const body = response.body as { statusCode: number; message: string };
      expect(body.statusCode).toBe(409);
      expect(typeof body.message).toBe('string');
    });

    it.each([
      ['invalid email', { email: 'not-an-email', password: 'password123' }],
      [
        'password shorter than 8',
        { email: 'ok@example.com', password: 'short' },
      ],
      ['missing password', { email: 'ok@example.com' }],
      ['empty body', {}],
    ])('400: %s is rejected with a string message', async (_name, payload) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(payload)
        .expect(400);

      const errorBody = response.body as {
        statusCode: number;
        message: string;
      };
      expect(errorBody.statusCode).toBe(400);
      expect(typeof errorBody.message).toBe('string'); // Error.message: string
    });
  });

  describe('GET /api/v1/auth/me', () => {
    const credentials = { email: 'me@example.com', password: 'password123' };
    let accessToken: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(credentials)
        .expect(201);
      accessToken = (response.body as { accessToken: string }).accessToken;
    });

    it('200: returns the account (User schema) for a valid token', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = response.body as { id: string; email: string };
      expect(typeof body.id).toBe('string');
      expect(body.email).toBe(credentials.email);
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('401: missing Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .expect(401);

      const body = response.body as { statusCode: number; message: string };
      expect(body.statusCode).toBe(401);
      expect(typeof body.message).toBe('string');
    });

    it('401: non-Bearer scheme is rejected', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Basic ${accessToken}`)
        .expect(401);
    });

    it('401: tampered token is rejected', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}x`)
        .expect(401);
    });

    it('401: expired token is rejected', async () => {
      const expired = await new JwtService({
        secret: process.env.JWT_SECRET,
      }).signAsync(
        { sub: 'user-1', email: credentials.email },
        { expiresIn: '-1s' },
      );

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
    });

    it('401: valid token of a deleted account is rejected', async () => {
      const ghost = await new JwtService({
        secret: process.env.JWT_SECRET,
      }).signAsync({ sub: 'no-such-user', email: 'ghost@example.com' });

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${ghost}`)
        .expect(401);
    });
  });

  describe('GET /api/v1/banks', () => {
    const hostA = { email: 'host-a@example.com', password: 'password123' };
    const hostB = { email: 'host-b@example.com', password: 'password123' };
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
      const [responseA, responseB] = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/auth/register').send(hostA),
        request(app.getHttpServer()).post('/api/v1/auth/register').send(hostB),
      ]);
      tokenA = (responseA.body as { accessToken: string }).accessToken;
      tokenB = (responseB.body as { accessToken: string }).accessToken;

      const idA = prismaMock.userIdByEmail(hostA.email);
      prismaMock.seedBank(idA, 'Lexis', 5, 3);
      prismaMock.seedBank(idA, 'Grammar', 2, 0);
    });

    it('401: requires a bearer token', async () => {
      await request(app.getHttpServer()).get('/api/v1/banks').expect(401);
    });

    it('200: returns Bank[] with DB-computed counters, newest first', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/banks')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const banks = response.body as {
        id: string;
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

  describe('POST /api/v1/auth/login', () => {
    const credentials = { email: 'login@example.com', password: 'password123' };

    beforeAll(async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(credentials)
        .expect(201);
    });

    it('200: returns an AuthToken for valid credentials', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(credentials)
        .expect(200);

      const body = response.body as { accessToken: string };
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.split('.')).toHaveLength(3); // JWT shape
    });

    it('200: email is matched case-insensitively', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'Login@Example.COM', password: credentials.password })
        .expect(200);
    });

    it('401: wrong password and unknown email get the same message', async () => {
      const wrongPassword = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: credentials.email, password: 'wrong-password-1' })
        .expect(401);

      const unknownEmail = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'ghost@example.com', password: credentials.password })
        .expect(401);

      const bodyA = wrongPassword.body as {
        statusCode: number;
        message: string;
      };
      const bodyB = unknownEmail.body as {
        statusCode: number;
        message: string;
      };
      expect(bodyA.statusCode).toBe(401);
      expect(typeof bodyA.message).toBe('string');
      expect(bodyA.message).toBe(bodyB.message); // no user enumeration
    });

    it('400: invalid body is rejected before hitting the database', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: 'password123' })
        .expect(400);

      const errorBody = response.body as {
        statusCode: number;
        message: string;
      };
      expect(errorBody.statusCode).toBe(400);
      expect(typeof errorBody.message).toBe('string');
    });
  });
});
