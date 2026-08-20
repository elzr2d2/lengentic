import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
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

/**
 * Nest types `getHttpServer()` as `any`, which `no-unsafe-argument` rejects at the supertest
 * call. The invariant is externally proven — the Express adapter's server IS an
 * `http.Server` — so the assertion is made once here rather than at each call site.
 */
const httpServer = (app: INestApplication): Server => app.getHttpServer() as Server;

describe('GET /health (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.NODE_ENV = 'test';
    // 'fatal', not pino's 'silent'. `envSchema` admits six levels and 'silent' is not one of
    // them, so setting it fails validation rather than quieting anything. 'fatal' is the
    // quietest value the contract actually allows.
    process.env.LOG_LEVEL = 'fatal';

    // Imported here, not at the top of the file. `AppModule` calls `ConfigModule.forRoot`
    // in its decorator, and `forRoot` validates the environment synchronously as the module
    // is evaluated — which, for a static import, is before this hook has run and before the
    // container above exists to supply DATABASE_URL. A static import fails the suite during
    // collection, so both tests report as skipped and the container's connection URI is
    // never read by anything.
    const { AppModule } = await import('../src/app.module');

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
    const response = await request(httpServer(app)).get('/health');

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

    const response = await request(httpServer(app)).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });
});
