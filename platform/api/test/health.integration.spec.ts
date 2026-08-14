import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Integration tests (MVP_PLAN.md §34, corrections doc §11).
 *
 * These run against a real PostgreSQL in a real container, not a mock. The behaviour under
 * test — what the API does when its database goes away — is precisely the behaviour a
 * mocked Prisma client cannot tell you anything about.
 *
 * Deliberately NOT part of `pnpm test`. They require a Docker daemon, and a suite that
 * silently skips when its prerequisite is missing is a green test that proves nothing.
 * Run them with `pnpm test:integration`.
 *
 * The image tag is pinned. `postgres:latest` makes a test that passed yesterday and fails
 * today look like a regression in code that did not change.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';

describe('GET /health (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('returns 200 and reports the database up', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  it('returns 503, not 500, once the database becomes unreachable', async () => {
    // This is the exact failure the handoff schema example in §25 describes. A dependency
    // being down is 503 — an orchestrator reads that as "do not route traffic here yet".
    // A 500 is indistinguishable from the API itself being broken and triggers the wrong
    // response from whoever is on call.
    const prisma = app.get(PrismaService);
    await prisma.client.$disconnect();
    await container.stop();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });
});
