import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * In-memory PrismaService stand-in: emulates the users table with its
 * unique-email constraint (rejects with code P2002, like PostgreSQL + Prisma).
 */
class PrismaMock {
  private readonly usersByEmail = new Map<
    string,
    { id: string; email: string }
  >();

  user = {
    create: ({ data }: { data: { email: string; passwordHash: string } }) => {
      if (this.usersByEmail.has(data.email)) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed on email'), {
            code: 'P2002',
          }),
        );
      }
      const user = {
        id: `user-${this.usersByEmail.size + 1}`,
        email: data.email,
      };
      this.usersByEmail.set(data.email, user);
      return Promise.resolve(user);
    },
  };
}

describe('POST /api/v1/auth/register (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-secret';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaMock())
      .compile();

    app = setupApp(moduleRef.createNestApplication<INestApplication<App>>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

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
    ['password shorter than 8', { email: 'ok@example.com', password: 'short' }],
    ['missing password', { email: 'ok@example.com' }],
    ['empty body', {}],
  ])('400: %s is rejected with a string message', async (_name, body) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body)
      .expect(400);

    const errorBody = response.body as { statusCode: number; message: string };
    expect(errorBody.statusCode).toBe(400);
    expect(typeof errorBody.message).toBe('string'); // Error.message: string
  });
});
