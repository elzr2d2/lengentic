import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Server } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  RecommendationListViewSchema,
  RepeatedFailedActionListViewSchema,
  type AnalysisRunResponse,
  type RepeatedFailedActionListView,
} from '@lengentic/shared';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Real-Postgres coverage for Scenario 2's platform path (`p6.s2-platform-path`, Phase 6
 * phase-gate finding F1): `tool_call.recorded` carries a sanitized `inputFingerprint`,
 * `POST /v1/analysis/run` evaluates §20.2 over the persisted tool calls, and the result is a
 * `REPEATED_FAILED_ACTION` recommendation readable at
 * `GET /v1/recommendations?category=REPEATED_FAILED_ACTION`.
 *
 * Data goes in exclusively through `POST /v1/telemetry/events`, the real ingest path, so a
 * streak here is one a caller could actually produce. The fingerprint strings are opaque
 * constants — the SDK computes the real ones, and `p7.e2e` owns the through-the-SDK proof;
 * this file proves the platform half does what the SDK's output asks of it.
 *
 * Negative cases first: §20.2 is defined by what it refuses to say, and a false positive is
 * what kills a recommendations product.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../database');

const httpServer = (app: INestApplication): Server => app.getHttpServer() as Server;

type Event = Record<string, unknown>;

const RUN_ID = 'rfa-run-1';
const FP_A = 'a1b2c3d4e5f60718';
const FP_B = '0f1e2d3c4b5a6978';
const CATEGORY = '?category=REPEATED_FAILED_ACTION';

function runStarted(runId: string): Event {
  return {
    eventId: `${runId}-start`,
    schemaVersion: '2',
    type: 'run.started',
    entityId: runId,
    runId,
    occurredAt: '2026-10-26T10:00:00.000Z',
    payload: { workflowName: 'repeated-failure-workflow', workflowVersion: '1.0.0' },
  };
}

interface Attempt {
  readonly id: string;
  /** Minutes after 10:00:00Z on 2026-10-26 — the client clock, which orders attempts. */
  readonly minute: number;
  readonly success?: boolean;
  readonly fingerprint?: string | null;
  readonly runId?: string;
  readonly toolName?: string;
}

function toolCall(attempt: Attempt): Event {
  const runId = attempt.runId ?? RUN_ID;
  const startedAt = new Date(Date.UTC(2026, 9, 26, 10, attempt.minute)).toISOString();
  const success = attempt.success ?? false;
  const fingerprint = attempt.fingerprint === undefined ? FP_A : attempt.fingerprint;

  return {
    eventId: `${attempt.id}-evt`,
    schemaVersion: '2',
    type: 'tool_call.recorded',
    entityId: attempt.id,
    runId,
    occurredAt: startedAt,
    payload: {
      stepId: `${attempt.id}-step`,
      toolName: attempt.toolName ?? 'run_tests',
      input: { command: 'pnpm test', target: 'checkout.spec.ts' },
      output: { exitCode: success ? 0 : 1 },
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 52,
      outputBytes: 14,
      ...(fingerprint === null ? {} : { inputFingerprint: fingerprint }),
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      success,
      error: success ? null : 'AssertionError: expected 42 to equal 40',
    },
  };
}

/** Scenario 2: one run, one tool, one input, three consecutive failures. */
const S2: Attempt[] = [
  { id: 'tc-1', minute: 1 },
  { id: 'tc-2', minute: 2 },
  { id: 'tc-3', minute: 3 },
];

describe('REPEATED_FAILED_ACTION through POST /v1/analysis/run against a real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const ingest = async (events: readonly Event[]): Promise<void> => {
    const response = await request(httpServer(app))
      .post('/v1/telemetry/events')
      .send({ events: [...events] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { accepted: number; rejected: number; results: unknown[] };
    expect(body.rejected, JSON.stringify(body.results)).toBe(0);
  };

  const analyze = async (): Promise<AnalysisRunResponse> => {
    const response = await request(httpServer(app)).post('/v1/analysis/run').send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as AnalysisRunResponse;
  };

  const listRfa = async (): Promise<RepeatedFailedActionListView> => {
    const response = await request(httpServer(app)).get(`/v1/recommendations${CATEGORY}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return RepeatedFailedActionListViewSchema.parse(response.body);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const connectionString = container.getConnectionUri();

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DATABASE_DIR,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    process.env.DATABASE_URL = connectionString;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';

    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const { configureBodyParser } = await import('../src/common/configure-body-parser');
    configureBodyParser(app);
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();

    prisma = app.get(PrismaService);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.client.$executeRawUnsafe(
      'TRUNCATE TABLE "Run", "Step", "IngestedEvent", "Decision", "ToolCall", "Recommendation" RESTART IDENTITY CASCADE',
    );
  });

  const expectNoRecommendation = async (): Promise<void> => {
    const body = await analyze();
    expect(body.repeatedFailedActions).toStrictEqual([]);
    expect(await prisma.client.recommendation.count()).toBe(0);
    expect((await listRfa()).recommendations).toStrictEqual([]);
  };

  // -------------------------------------------------------------------------
  // Negatives first: everything that must emit NOTHING.
  // -------------------------------------------------------------------------

  it('emits nothing over an empty database', async () => {
    await expectNoRecommendation();
  });

  it('emits nothing for TWO failures', async () => {
    await ingest([runStarted(RUN_ID), toolCall(S2[0]!), toolCall(S2[1]!)]);

    await expectNoRecommendation();
  });

  it('emits nothing when a success sits BETWEEN the failures', async () => {
    await ingest([
      runStarted(RUN_ID),
      toolCall({ id: 'tc-1', minute: 1 }),
      toolCall({ id: 'tc-2', minute: 2 }),
      toolCall({ id: 'tc-3', minute: 3, success: true }),
      toolCall({ id: 'tc-4', minute: 4 }),
      toolCall({ id: 'tc-5', minute: 5 }),
    ]);

    await expectNoRecommendation();
  });

  it('emits nothing for three failures spread ACROSS runs', async () => {
    await ingest([
      runStarted('rfa-run-1'),
      runStarted('rfa-run-2'),
      runStarted('rfa-run-3'),
      toolCall({ id: 'tc-1', minute: 1, runId: 'rfa-run-1' }),
      toolCall({ id: 'tc-2', minute: 2, runId: 'rfa-run-2' }),
      toolCall({ id: 'tc-3', minute: 3, runId: 'rfa-run-3' }),
    ]);

    await expectNoRecommendation();
  });

  it('emits nothing for three failures of three DIFFERENT inputs', async () => {
    await ingest([
      runStarted(RUN_ID),
      toolCall({ id: 'tc-1', minute: 1, fingerprint: 'aaaaaaaaaaaaaaaa' }),
      toolCall({ id: 'tc-2', minute: 2, fingerprint: 'bbbbbbbbbbbbbbbb' }),
      toolCall({ id: 'tc-3', minute: 3, fingerprint: 'cccccccccccccccc' }),
    ]);

    await expectNoRecommendation();
  });

  it('emits nothing for three failures of the same input across DIFFERENT tools', async () => {
    await ingest([
      runStarted(RUN_ID),
      toolCall({ id: 'tc-1', minute: 1, toolName: 'lint' }),
      toolCall({ id: 'tc-2', minute: 2, toolName: 'run_tests' }),
      toolCall({ id: 'tc-3', minute: 3, toolName: 'build' }),
    ]);

    await expectNoRecommendation();
  });

  it('emits nothing for failures from an SDK that sent no fingerprint — unknown input is not equal input', async () => {
    await ingest([
      runStarted(RUN_ID),
      ...S2.map((attempt) => toolCall({ ...attempt, fingerprint: null })),
    ]);

    await expectNoRecommendation();
  });

  it('emits nothing for three SUCCESSFUL calls', async () => {
    await ingest([
      runStarted(RUN_ID),
      ...S2.map((attempt) => toolCall({ ...attempt, success: true })),
    ]);

    await expectNoRecommendation();
  });

  // -------------------------------------------------------------------------
  // The positive path.
  // -------------------------------------------------------------------------

  it('persists the fingerprint the wire carried, and never the raw input beside it', async () => {
    await ingest([runStarted(RUN_ID), toolCall(S2[0]!)]);

    const row = await prisma.client.toolCall.findUniqueOrThrow({ where: { id: 'tc-1' } });

    expect(row.inputFingerprint).toBe(FP_A);
  });

  it('Scenario 2 data yields exactly ONE OPEN REPEATED_FAILED_ACTION with attemptCount 3 and the three toolCallIds', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);

    const body = await analyze();

    expect(body.repeatedFailedActions).toHaveLength(1);
    const emitted = body.repeatedFailedActions![0]!;
    expect(emitted.attemptCount).toBe(3);
    expect(emitted.toolCallIds).toStrictEqual(['tc-1', 'tc-2', 'tc-3']);

    const page = await listRfa();
    expect(page.recommendations).toHaveLength(1);
    const recommendation = page.recommendations[0]!;
    expect(recommendation.id).toBe(emitted.recommendationId);
    expect(recommendation.category).toBe('REPEATED_FAILED_ACTION');
    expect(recommendation.status).toBe('OPEN');
    expect(recommendation.actionKey).toStrictEqual({
      runId: RUN_ID,
      toolName: 'run_tests',
      inputFingerprint: FP_A,
    });
    expect(recommendation.evidence).toStrictEqual({
      attemptCount: 3,
      toolCallIds: ['tc-1', 'tc-2', 'tc-3'],
    });
    expect(recommendation.analyzerId).toBe('repeated-failed-action');
    expect(recommendation.configSnapshot).toStrictEqual({ minConsecutiveFailures: 3 });
    // Present, and empty: no success was attested, and the key is never omitted.
    expect(recommendation.counterexamples).toStrictEqual([]);
    expect(await prisma.client.recommendation.count()).toBe(1);
  });

  it('never leaks the raw tool input into the persisted recommendation', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();

    const row = await prisma.client.recommendation.findFirstOrThrow();

    expect(JSON.stringify(row)).not.toContain('pnpm test');
    expect(JSON.stringify(row)).not.toContain('checkout.spec.ts');
  });

  it('keeps the §20.1 list read unchanged: the default list never contains a §20.2 row', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();

    const response = await request(httpServer(app)).get('/v1/recommendations');
    const defaultPage = RecommendationListViewSchema.parse(response.body);

    expect(defaultPage.recommendations).toStrictEqual([]);
  });

  it('re-running analysis DEDUPES: same row, same id, firstSeenAt kept, lastSeenAt advanced', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);

    const first = await analyze();
    // Backdate `lastSeenAt` instead of waiting for the clock to move: the row's own column
    // is the observable, and a known-old instant makes "advanced" a comparison, not a race.
    const longAgo = new Date('2026-01-01T00:00:00.000Z');
    await prisma.client.recommendation.updateMany({ data: { lastSeenAt: longAgo } });
    const [before] = (await listRfa()).recommendations;
    const second = await analyze();
    const [after] = (await listRfa()).recommendations;

    expect(second.repeatedFailedActions![0]!.recommendationId).toBe(
      first.repeatedFailedActions![0]!.recommendationId,
    );
    expect(await prisma.client.recommendation.count()).toBe(1);
    expect(after!.id).toBe(before!.id);
    expect(after!.firstSeenAt).toBe(before!.firstSeenAt);
    expect(before!.lastSeenAt).toBe(longAgo.toISOString());
    expect(new Date(after!.lastSeenAt).getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it('a streak that GROWS from three to four refreshes the same row, not a second one', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();
    await ingest([toolCall({ id: 'tc-4', minute: 4 })]);

    const body = await analyze();

    expect(body.repeatedFailedActions![0]!.attemptCount).toBe(4);
    const page = await listRfa();
    expect(page.recommendations).toHaveLength(1);
    expect(page.recommendations[0]!.evidence.toolCallIds).toStrictEqual([
      'tc-1',
      'tc-2',
      'tc-3',
      'tc-4',
    ]);
  });

  it('lists a success that followed the streak as a counterexample', async () => {
    await ingest([
      runStarted(RUN_ID),
      ...S2.map(toolCall),
      toolCall({ id: 'tc-4', minute: 4, success: true }),
    ]);

    await analyze();

    expect((await listRfa()).recommendations[0]!.counterexamples).toStrictEqual([
      { toolCallId: 'tc-4', runId: RUN_ID, outcome: 'SUCCESS' },
    ]);
  });

  it('two independent streaks (two inputs) are two recommendations', async () => {
    await ingest([
      runStarted(RUN_ID),
      ...S2.map(toolCall),
      toolCall({ id: 'tc-b1', minute: 11, fingerprint: FP_B }),
      toolCall({ id: 'tc-b2', minute: 12, fingerprint: FP_B }),
      toolCall({ id: 'tc-b3', minute: 13, fingerprint: FP_B }),
    ]);

    const body = await analyze();

    expect(body.repeatedFailedActions).toHaveLength(2);
    expect(await prisma.client.recommendation.count()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Lifecycle: DISMISSED survives, and a vanished streak is withdrawn.
  // -------------------------------------------------------------------------

  it('a DISMISSED streak stays DISMISSED across re-analysis', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();
    const [row] = (await listRfa()).recommendations;

    const patched = await request(httpServer(app))
      .patch(`/v1/recommendations/${row!.id}/status`)
      .send({ status: 'DISMISSED', note: 'known flaky suite' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as { category: string }).category).toBe('REPEATED_FAILED_ACTION');

    await analyze();

    const [after] = (await listRfa()).recommendations;
    expect(after!.status).toBe('DISMISSED');
    expect(after!.statusNote).toBe('known flaky suite');
    expect(await prisma.client.recommendation.count()).toBe(1);
  });

  it('WITHDRAWS an OPEN streak the data no longer supports — a claim the analyzer stopped making leaves no row', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();
    expect(await prisma.client.recommendation.count()).toBe(1);

    await prisma.client.toolCall.deleteMany({ where: { id: 'tc-3' } });
    const body = await analyze();

    expect(body.repeatedFailedActions).toStrictEqual([]);
    expect(await prisma.client.recommendation.count()).toBe(0);
    expect((await listRfa()).recommendations).toStrictEqual([]);
  });

  it('keeps a DISMISSED tombstone when the streak vanishes', async () => {
    await ingest([runStarted(RUN_ID), ...S2.map(toolCall)]);
    await analyze();
    const [row] = (await listRfa()).recommendations;
    await request(httpServer(app))
      .patch(`/v1/recommendations/${row!.id}/status`)
      .send({ status: 'DISMISSED' });

    await prisma.client.toolCall.deleteMany({ where: { id: 'tc-3' } });
    await analyze();

    expect((await listRfa()).recommendations.map((r) => r.status)).toStrictEqual(['DISMISSED']);
  });
});
