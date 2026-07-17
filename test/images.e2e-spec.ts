import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

// UPLOADS_DIR is read at import time - point it to a temp dir first.
const uploadsDir = mkdtempSync(join(tmpdir(), 'uniquiz-uploads-'));
process.env.UPLOADS_DIR = uploadsDir;

/* eslint-disable import/first */
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { IMAGE_MAX_BYTES } from '../src/images/images.constants';
import { PrismaMock } from './prisma.mock';
/* eslint-enable import/first */

/** Minimal valid PNG header + payload of the requested size. */
function fakePng(bytes: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    header,
    Buffer.alloc(Math.max(0, bytes - header.length)),
  ]);
}

describe('POST /api/v1/images (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-secret';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaMock())
      .compile();

    app = setupApp(moduleRef.createNestApplication<INestApplication<App>>());
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'uploader@example.com', password: 'password123' })
      .expect(201);
    token = (response.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
    rmSync(uploadsDir, { recursive: true, force: true });
  });

  it('201: stores a valid image and returns a public url', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fakePng(2048), 'photo.png')
      .expect(201);

    const body = response.body as { url: string };
    expect(body.url).toMatch(/\/uploads\/[0-9a-f-]+\.png$/);
  });

  it('413: a file over the limit is rejected', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fakePng(IMAGE_MAX_BYTES + 1024), 'huge.png')
      .expect(413);
  });

  it('400: a non-image upload is rejected', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('#!/bin/sh\necho hi\n'), {
        filename: 'script.sh',
        contentType: 'application/x-sh',
      })
      .expect(400);
  });

  it('400: missing file field is rejected', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('401: requires a bearer token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .attach('file', fakePng(128), 'photo.png')
      .expect(401);
  });
});
