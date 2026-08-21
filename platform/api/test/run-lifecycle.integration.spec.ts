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
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { CLOCK, type Clock } from '../src/common/clock';
import { INGEST_LIMITS, type IngestResponse } from '@lengentic/shared';
import type { RunDetailView, RunListView } from '@lengentic/shared/read';

/**
 * `p2.integration-tests` — the four areas of this lane's deliverable, each proven end to end
 * against a real Postgres through the real HTTP boundary: **ingestion**, **idempotency**,
 * **ordering**, **STALE**.
 *
 * ## The seams under test
 *
 * Exactly two, and nothing reaches past them:
 *
 * 1. **HTTP.** `POST /v1/telemetry/events`, `GET /v1/runs`, `GET /v1/runs/:id` — driven with
 *    supertest over a real `http.Server`, through real Nest routing, the real
 *    `zodBody`/`IngestRequestSchema` pipe, the real service, repository and
 *    `AllExceptionsFilter`. No service class is constructed by hand here, and no repository
 *    method is called directly: a test that calls `TelemetryService.ingest` cannot see a
 *    request-level 400, and one that calls `RunsService.findById` cannot see the derived
 *    status a browser would actually receive.
 * 2. **The stored row**, read straight out of Postgres via `PrismaService.client`. This is
 *    the *second observable interface* the STALE tests need and the reason they can fail:
 *    ADR 0005 decision 4 requires `STALE` to be derived at read time and **never written to
 *    a row**, so proving it takes both halves at once — the API says `STALE` *while* the row
 *    still says `RUNNING`. Either half alone passes on a wrong implementation (a
 *    `status`-column writer satisfies the first; an endpoint that never derives satisfies
 *    the second).
 *
 * ## What is deliberately NOT here
 *
 * - The STALE *arithmetic* as a pure function. `platform/api/src/runs/stale.spec.ts` already
 *   covers `deriveRunViewStatus` at the boundary with no container. Repeating it here would
 *   buy a slower copy of an existing test. What only this file can prove is that the value
 *   reaching the wire came from a real row, a real `STALE_RUN_THRESHOLD_MS` and a real
 *   request.
 * - The merge rules as permutations. `merge-rules.spec.ts` owns those in-process. This file
 *   proves the §12 cases that are about *persisted state across real request boundaries*.
 * - `telemetry.integration.spec.ts`'s F1/F2/D2/D3/T1/T4/T5 regression fixtures, which belong
 *   to `p2.ingest-endpoint` and are not restated.
 *
 * ## The clock
 *
 * `CLOCK` is overridden with a settable test double — the seam `common/clock.ts` documents
 * as existing for exactly this. `STALE_RUN_THRESHOLD_MS` is deliberately **not** overridden:
 * it is deleted from the environment in `beforeAll` so the *shipped default* in
 * `config/env.schema.ts` is what every assertion below runs against, and the expected value
 * is the literal thirty minutes OD-1 resolved. That way a silent regression of the default
 * back to the 15 minutes that shipped as a defect fails this file rather than passing it.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../database');

/**
 * Thirty minutes, in milliseconds.
 *
 * Sourced from the decision, not from the code under test: ADR 0005 decision 4 fixes the
 * rule as `now - lastEventAt > STALE_RUN_THRESHOLD`, and OD-1 resolved the threshold to
 * thirty minutes after an earlier default of fifteen shipped as a defect. Written as
 * `30 * 60 * 1000` rather than imported from `env.schema.ts` on purpose — importing it would
 * make this file agree with whatever the config happens to say, which is the tautology the
 * `test-at-seams` skill names. Here the config has to agree with the decision.
 */
const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000;

/** A settable `Clock`. `now` is an input to the STALE rule, so the test owns it. */
class TestClock implements Clock {
  current = new Date();
  now(): Date {
    return this.current;
  }
}

interface WireEvent {
  readonly eventId: string;
  readonly schemaVersion: '1';
  readonly type: 'run.started' | 'run.completed' | 'step.started' | 'step.completed';
  readonly entityId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

function runStarted(
  runId: string,
  eventId: string,
  occurredAt: string,
  payload: Record<string, unknown> = {},
): WireEvent {
  return {
    eventId,
    schemaVersion: '1',
    type: 'run.started',
    entityId: runId,
    runId,
    occurredAt,
    payload: { workflowName: 'checkout-agent', workflowVersion: '1.4.2', ...payload },
  };
}

function runCompleted(
  runId: string,
  eventId: string,
  occurredAt: string,
  status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
  payload: Record<string, unknown> = {},
): WireEvent {
  return {
    eventId,
    schemaVersion: '1',
    type: 'run.completed',
    entityId: runId,
    runId,
    occurredAt,
    payload: { status, ...payload },
  };
}

function stepStarted(
  runId: string,
  stepId: string,
  eventId: string,
  occurredAt: string,
  parentStepId: string | null,
): WireEvent {
  return {
    eventId,
    schemaVersion: '1',
    type: 'step.started',
    entityId: stepId,
    runId,
    occurredAt,
    payload: { name: stepId, agentName: 'planner', type: 'tool', parentStepId },
  };
}

describe('Run lifecycle through the real API against a real Postgres (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const clock = new TestClock();

  const httpServer = (a: INestApplication): Server => a.getHttpServer() as Server;

  const post = async (events: readonly unknown[]): Promise<IngestResponse> => {
    const response = await request(httpServer(app)).post('/v1/telemetry/events').send({ events });
    expect(response.status, JSON.stringify(response.body as unknown)).toBe(200);
    return response.body as IngestResponse;
  };

  const detail = async (runId: string): Promise<RunDetailView> => {
    const response = await request(httpServer(app)).get(`/v1/runs/${runId}`);
    expect(response.status, JSON.stringify(response.body as unknown)).toBe(200);
    return response.body as RunDetailView;
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
    // The shipped default is what is under test — see STALE_RUN_THRESHOLD_MS above.
    delete process.env.STALE_RUN_THRESHOLD_MS;

    const [
      { ConfigModule },
      { PrismaModule },
      { TelemetryModule },
      { RunsModule },
      { validateEnv },
    ] = await Promise.all([
      import('@nestjs/config'),
      import('../src/prisma/prisma.module'),
      import('../src/telemetry/telemetry.module'),
      import('../src/runs/runs.module'),
      import('../src/config/env.schema'),
    ]);

    moduleRef = await Test.createTestingModule({
      imports: [
        // `ignoreEnvFile` so the only source of configuration is the environment this hook
        // just set. Without it a `.env` sitting in the package directory could supply a
        // different STALE_RUN_THRESHOLD_MS and quietly move every boundary asserted below.
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          ignoreEnvFile: true,
          validate: validateEnv,
        }),
        PrismaModule,
        TelemetryModule,
        RunsModule,
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();

    // Same assembly `main.ts` performs, minus `nestjs-pino` — see the note in
    // `telemetry.integration.spec.ts` for why that one module is left out of integration
    // apps here. Nothing on the path under test (routing, validation, service, repository,
    // filter) differs.
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const { configureBodyParser } = await import('../src/common/configure-body-parser');
    configureBodyParser(app);
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();

    prisma = app.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    // `MVP_PLAN_V3.md` §6: "truncate between tests". Every test below owns the whole table
    // contents, which is what lets the `GET /v1/runs` assertions name an exact page rather
    // than hunting for their own row inside someone else's data.
    await prisma.client.$executeRawUnsafe(
      'TRUNCATE TABLE "Run", "Step", "IngestedEvent" RESTART IDENTITY CASCADE',
    );
    clock.current = new Date();
  });

  describe('Ingestion (§12 envelope)', () => {
    it('a full run — started, two steps, completed — posted in one batch lands as one Run with both Steps, readable at GET /v1/runs/:id', async () => {
      const runId = 'ingest-full-run';

      const response = await post([
        runStarted(runId, 'e-run-start', '2026-08-19T10:00:00.000Z'),
        stepStarted(
          runId,
          'ingest-step-parent',
          'e-parent-start',
          '2026-08-19T10:00:01.000Z',
          null,
        ),
        stepStarted(
          runId,
          'ingest-step-child',
          'e-child-start',
          '2026-08-19T10:00:02.000Z',
          'ingest-step-parent',
        ),
        runCompleted(runId, 'e-run-complete', '2026-08-19T10:05:00.000Z'),
      ]);

      expect(response.accepted).toBe(4);
      expect(response.duplicate).toBe(0);
      expect(response.rejected).toBe(0);
      expect(response.results.map((r) => r.status)).toEqual([
        'ACCEPTED',
        'ACCEPTED',
        'ACCEPTED',
        'ACCEPTED',
      ]);

      const view = await detail(runId);

      expect(view.workflowName).toBe('checkout-agent');
      expect(view.workflowVersion).toBe('1.4.2');
      expect(view.status).toBe('COMPLETED');
      expect(view.startedAt).toBe('2026-08-19T10:00:00.000Z');
      expect(view.completedAt).toBe('2026-08-19T10:05:00.000Z');
      expect(view.steps.map((s) => s.id).sort()).toEqual([
        'ingest-step-child',
        'ingest-step-parent',
      ]);
      expect(view.steps.find((s) => s.id === 'ingest-step-child')?.parentStepId).toBe(
        'ingest-step-parent',
      );
      expect(view.steps.find((s) => s.id === 'ingest-step-parent')?.parentStepId).toBeNull();
    });

    it('a malformed event in a batch rejects only itself — its two well-formed siblings still land as rows', async () => {
      const response = await post([
        runStarted('ingest-good-before', 'e-good-before', '2026-08-19T10:00:00.000Z'),
        {
          eventId: 'e-malformed',
          schemaVersion: '1',
          type: 'run.exploded', // not a member of TELEMETRY_EVENT_TYPES
          entityId: 'ingest-malformed',
          runId: 'ingest-malformed',
          occurredAt: '2026-08-19T10:00:00.000Z',
          payload: {},
        },
        runStarted('ingest-good-after', 'e-good-after', '2026-08-19T10:00:00.000Z'),
      ]);

      expect(response.accepted).toBe(2);
      expect(response.rejected).toBe(1);
      expect(response.results.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED']);
      expect(response.results[1]?.error?.code).toBe('UNKNOWN_EVENT_TYPE');

      // The business outcome, not just the response shape: two rows, and no row for the
      // rejected event's entity.
      const ids = (await prisma.client.run.findMany({ select: { id: true } })).map((r) => r.id);
      expect(ids.sort()).toEqual(['ingest-good-after', 'ingest-good-before']);
    });

    it('an empty events array is a request-level rejection — HTTP 400, no per-event results, nothing written', async () => {
      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({ events: [] });

      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('results');
      expect(await prisma.client.run.count()).toBe(0);
    });

    it('a batch one event over the 500-event maximum is a request-level rejection — HTTP 400, and none of the 501 events lands', async () => {
      const events = Array.from({ length: INGEST_LIMITS.maxEventsPerBatch + 1 }, (_, i) =>
        runStarted(`ingest-oversize-${i}`, `e-oversize-${i}`, '2026-08-19T10:00:00.000Z'),
      );

      const response = await request(httpServer(app)).post('/v1/telemetry/events').send({ events });

      expect(response.status).toBe(400);
      // The whole batch is rejected, not the 501st event: §12's request-level branch.
      expect(await prisma.client.run.count()).toBe(0);
    });
  });

  describe('Idempotency (§12, ADR 0009 A-7 — the IngestedEvent ledger)', () => {
    /**
     * ADR 0009's Detection section names this fixture and this arithmetic:
     *
     * > `p2.integration-tests` posts a batch containing at least one event that loses its
     * > merge contest, then re-posts the identical batch, and asserts `accepted: 0,
     * > duplicate: N` with per-event `DUPLICATE` on **every** event. The 2026-08-20
     * > `f3.out` D2.2 sequence is the ready-made negative fixture — it must flip from
     * > `accepted:2, duplicate:2` to `accepted:0, duplicate:4`.
     *
     * So the batch is built to contain two losers on purpose. `s-late` loses
     * first-writer-wins to `s-early`; `c-early` loses last-writer-wins to `c-late`. Under
     * the entity-state-derived interim those two left no trace on the row and were
     * re-classified `ACCEPTED` forever. Replaying only winners is the green that lies A-7
     * was written to prevent, and is explicitly not evidence for this record.
     */
    const d22Batch = (runId: string): WireEvent[] => [
      runStarted(runId, 's-late', '2026-08-19T10:00:00.000Z'),
      runStarted(runId, 's-early', '2026-08-19T09:00:00.000Z'),
      runCompleted(runId, 'c-early', '2026-08-19T11:00:00.000Z'),
      runCompleted(runId, 'c-late', '2026-08-19T12:00:00.000Z'),
    ];

    it('replaying a batch that contains merge losers returns accepted:0, duplicate:4 — every event DUPLICATE, not only the winners (ADR 0009 A-7)', async () => {
      const runId = 'idem-d22';

      const first = await post(d22Batch(runId));
      expect({ accepted: first.accepted, duplicate: first.duplicate }).toEqual({
        accepted: 4,
        duplicate: 0,
      });

      const second = await post(d22Batch(runId));

      // The literal from ADR 0009 Detection, not a value read back from the first response.
      expect({ accepted: second.accepted, duplicate: second.duplicate }).toEqual({
        accepted: 0,
        duplicate: 4,
      });
      expect(second.results.map((r) => r.status)).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
      ]);

      // The ledger itself, ADR 0005 §1 — the thing that makes the four DUPLICATEs true
      // rather than coincidental. If dedup regressed to entity-state provenance
      // (`startEventId`/`completionEventId`, two columns, two winners) this assertion goes
      // red first and names why.
      const ledger = await prisma.client.ingestedEvent.findMany({
        where: { runId },
        select: { eventId: true },
      });
      expect(ledger.map((row) => row.eventId).sort()).toEqual([
        'c-early',
        'c-late',
        's-early',
        's-late',
      ]);
    });

    it('a third identical replay is still accepted:0, duplicate:4 — the count converges instead of sitting stable at a wrong number', async () => {
      const runId = 'idem-d23';

      await post(d22Batch(runId));
      await post(d22Batch(runId));
      const third = await post(d22Batch(runId));

      // The D2.3 line of `f3.out` read `accepted 2, duplicate 2 (stable, not converging)`.
      expect({ accepted: third.accepted, duplicate: third.duplicate }).toEqual({
        accepted: 0,
        duplicate: 4,
      });
      // Still exactly one ledger row per event — a replay must not append.
      expect(await prisma.client.ingestedEvent.count({ where: { runId } })).toBe(4);
    });

    it('replaying a batch produces no duplicate rows and leaves the merged row byte-identical', async () => {
      const runId = 'idem-no-duplicate-rows';

      await post(d22Batch(runId));
      const before = await prisma.client.run.findUnique({ where: { id: runId } });

      await post(d22Batch(runId));
      const after = await prisma.client.run.findUnique({ where: { id: runId } });

      expect(await prisma.client.run.count()).toBe(1);
      // Not a spot-check of two columns: the whole row, so a replay that quietly moved
      // `completedAt`, `status` or a provenance column cannot pass.
      expect(after).toEqual(before);
      // And the winners are the ones §12's precedence rules name — earliest start,
      // latest completion — so "unchanged" is not "unchanged and wrong".
      expect(before?.startEventId).toBe('s-early');
      expect(before?.completionEventId).toBe('c-late');
    });

    it('the same eventId under a different runId is a new event, not a duplicate (ADR 0005 §2 keys the ledger on the pair)', async () => {
      const shared = '2026-08-19T10:00:00.000Z';

      const first = await post([runStarted('idem-run-a', 'shared-event-id', shared)]);
      const second = await post([runStarted('idem-run-b', 'shared-event-id', shared)]);

      expect(first.results[0]).toMatchObject({ status: 'ACCEPTED' });
      // A globally-unique index on eventId alone would report DUPLICATE here and lose a
      // genuinely new run — the Phase 3 `SeededIdGenerator` failure ADR 0005 §2 forecloses.
      expect(second.results[0]).toMatchObject({ status: 'ACCEPTED' });
      expect(await prisma.client.run.count()).toBe(2);
    });
  });

  describe('Ordering (§12 merge rules, across real request boundaries)', () => {
    it('a completion event arriving before its start event produces ONE row that stays terminal — the late start fills start fields and never reopens the run', async () => {
      const runId = 'order-completion-first';

      const completionFirst = await post([
        runCompleted(runId, 'e-complete-first', '2026-08-19T10:05:00.000Z'),
      ]);
      expect(completionFirst.results[0]).toMatchObject({ status: 'ACCEPTED' });

      // Created already terminal, from a completion event alone.
      const created = await detail(runId);
      expect(created.status).toBe('COMPLETED');
      expect(created.startedAt).toBeNull();

      // A separate request — arrival order across the wire, not permutation within a fold.
      await post([runStarted(runId, 'e-start-second', '2026-08-19T10:00:00.000Z')]);

      const view = await detail(runId);
      expect(view.status).toBe('COMPLETED');
      expect(view.startedAt).toBe('2026-08-19T10:00:00.000Z');
      expect(view.completedAt).toBe('2026-08-19T10:05:00.000Z');
      expect(view.workflowName).toBe('checkout-agent');
      expect(await prisma.client.run.count()).toBe(1);
    });

    it('a child Step posted before its parent is kept as an orphan and resolves into the correct tree once the parent arrives — no foreign key, nothing dropped', async () => {
      const runId = 'order-child-first';

      await post([runStarted(runId, 'e-run-start', '2026-08-19T10:00:00.000Z')]);
      await post([
        stepStarted(runId, 'order-child', 'e-child', '2026-08-19T10:00:02.000Z', 'order-parent'),
      ]);

      // Orphaned, not rejected and not silently dropped: the child is a row, pointing at a
      // parent that does not exist yet.
      const orphaned = await detail(runId);
      expect(orphaned.steps.map((s) => s.id)).toEqual(['order-child']);
      expect(orphaned.steps[0]?.parentStepId).toBe('order-parent');

      await post([
        stepStarted(runId, 'order-parent', 'e-parent', '2026-08-19T10:00:01.000Z', null),
      ]);

      const view = await detail(runId);
      const child = view.steps.find((s) => s.id === 'order-child');
      const parent = view.steps.find((s) => s.id === 'order-parent');

      expect(view.steps).toHaveLength(2);
      expect(child?.parentStepId).toBe('order-parent');
      expect(parent?.parentStepId).toBeNull();
      // The child's own fields survived the parent's arrival untouched.
      expect(child?.startedAt).toBe('2026-08-19T10:00:02.000Z');
      expect(child?.name).toBe('order-child');
    });

    it('conflicting terminal states resolve to FAILED in either arrival order — the answer does not depend on network timing', async () => {
      const completedFirst = 'order-terminal-completed-first';
      const failedFirst = 'order-terminal-failed-first';

      await post([
        runCompleted(completedFirst, 'e-cf-completed', '2026-08-19T10:05:00.000Z', 'COMPLETED'),
      ]);
      await post([
        runCompleted(completedFirst, 'e-cf-failed', '2026-08-19T10:06:00.000Z', 'FAILED'),
      ]);

      await post([runCompleted(failedFirst, 'e-ff-failed', '2026-08-19T10:05:00.000Z', 'FAILED')]);
      await post([
        runCompleted(failedFirst, 'e-ff-completed', '2026-08-19T10:06:00.000Z', 'COMPLETED'),
      ]);

      expect((await detail(completedFirst)).status).toBe('FAILED');
      // The interesting one: the LATER event says COMPLETED and still loses.
      expect((await detail(failedFirst)).status).toBe('FAILED');
    });
  });

  describe('STALE (ADR 0005 decision 4 — derived at read time, never written to a row)', () => {
    /**
     * Posts one `run.started` and hands back the row's `lastEventAt`, which is the server
     * clock reading that ingest actually stamped. Every boundary below is expressed relative
     * to that instant rather than to a fabricated one, so the arithmetic under test is the
     * arithmetic the API performs.
     */
    const startRunningRun = async (runId: string): Promise<Date> => {
      await post([runStarted(runId, `${runId}-start`, '2026-08-19T10:00:00.000Z')]);
      const row = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(row?.status).toBe('RUNNING');
      return row!.lastEventAt;
    };

    // Negative fixtures first — a STALE false positive marks a live run dead, which is the
    // direction that destroys trust in the Run Explorer.

    it('a run that has just emitted an event is RUNNING', async () => {
      const runId = 'stale-fresh';
      const lastEventAt = await startRunningRun(runId);
      clock.current = new Date(lastEventAt.getTime() + 1_000);

      expect((await detail(runId)).status).toBe('RUNNING');
    });

    it('a run idle for EXACTLY the threshold is still RUNNING — the rule is strictly greater than, not at least', async () => {
      const runId = 'stale-boundary-exact';
      const lastEventAt = await startRunningRun(runId);
      clock.current = new Date(lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS);

      expect((await detail(runId)).status).toBe('RUNNING');
    });

    it('a COMPLETED run idle far past the threshold never derives STALE — STALE substitutes for RUNNING only', async () => {
      const runId = 'stale-terminal-never';
      await post([
        runStarted(runId, `${runId}-start`, '2026-08-19T10:00:00.000Z'),
        runCompleted(runId, `${runId}-complete`, '2026-08-19T10:05:00.000Z'),
      ]);
      const row = await prisma.client.run.findUnique({ where: { id: runId } });
      clock.current = new Date(row!.lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS * 100);

      expect((await detail(runId)).status).toBe('COMPLETED');
    });

    it('a FAILED run idle far past the threshold never derives STALE either', async () => {
      const runId = 'stale-failed-never';
      await post([
        runStarted(runId, `${runId}-start`, '2026-08-19T10:00:00.000Z'),
        runCompleted(runId, `${runId}-complete`, '2026-08-19T10:05:00.000Z', 'FAILED'),
      ]);
      const row = await prisma.client.run.findUnique({ where: { id: runId } });
      clock.current = new Date(row!.lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS * 100);

      expect((await detail(runId)).status).toBe('FAILED');
    });

    // The positive case, and the one that needs both halves.

    it('one millisecond past the threshold, GET /v1/runs/:id reports STALE while the stored row still reads RUNNING', async () => {
      const runId = 'stale-boundary-past';
      const lastEventAt = await startRunningRun(runId);
      clock.current = new Date(lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS + 1);

      const view = await detail(runId);

      // Half one: the API substitutes STALE for RUNNING. `RUN_VIEW_STATUSES` makes this a
      // replacement, not an extra field — a consumer reading only `status` cannot display a
      // dead run as live.
      expect(view.status).toBe('STALE');
      // Half two: nothing was written. `RUN_STATUSES` has no STALE member and ADR 0005
      // decision 4 says "stored `status` stays RUNNING forever". Without this assertion the
      // test passes just as well against an implementation that persists STALE — which is
      // the implementation the decision exists to forbid.
      const row = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(row?.status).toBe('RUNNING');
      // And `lastEventAt` is on the wire, so a consumer can check the server's arithmetic.
      expect(view.lastEventAt).toBe(lastEventAt.toISOString());
    });

    it('GET /v1/runs derives STALE for the same run in the list, and the row underneath is still RUNNING', async () => {
      const runId = 'stale-in-list';
      const lastEventAt = await startRunningRun(runId);
      clock.current = new Date(lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS + 1);

      const response = await request(httpServer(app)).get('/v1/runs');
      expect(response.status).toBe(200);
      const list = response.body as RunListView;

      expect(list.runs).toHaveLength(1);
      expect(list.runs[0]?.id).toBe(runId);
      expect(list.runs[0]?.status).toBe('STALE');
      expect((await prisma.client.run.findUnique({ where: { id: runId } }))?.status).toBe(
        'RUNNING',
      );
    });

    it('a fresh run and a long-idle run in the same response are derived independently — one RUNNING, one STALE, both stored RUNNING', async () => {
      const idle = 'stale-mixed-idle';
      const fresh = 'stale-mixed-fresh';

      const idleLastEventAt = await startRunningRun(idle);
      const freshLastEventAt = await startRunningRun(fresh);

      // The two ingests are separate requests, so the server stamped them with separate
      // clock readings and `fresh` is strictly the later of the two. Asserted rather than
      // assumed: if the two ever landed on the same millisecond there would be no window
      // between them and the case below would be vacuous rather than wrong.
      expect(
        freshLastEventAt.getTime(),
        'fixture precondition: the second ingest is strictly later than the first',
      ).toBeGreaterThan(idleLastEventAt.getTime());

      // One clock reading for the whole page, placed exactly on `fresh`'s boundary. `fresh`
      // is therefore idle by exactly the threshold (not stale, strictly-greater-than), and
      // `idle` — stamped strictly earlier — is past it. The gap between the two rows is
      // whatever the two requests actually took, so nothing here depends on a fabricated
      // interval.
      clock.current = new Date(freshLastEventAt.getTime() + STALE_RUN_THRESHOLD_MS);

      const response = await request(httpServer(app)).get('/v1/runs');
      const list = response.body as RunListView;
      const byId = new Map(list.runs.map((r) => [r.id, r.status]));

      expect(byId.get(idle)).toBe('STALE');
      expect(byId.get(fresh)).toBe('RUNNING');
      const rows = await prisma.client.run.findMany({ select: { id: true, status: true } });
      expect(rows.every((r) => r.status === 'RUNNING')).toBe(true);
    });

    it('an event landing on a run that had derived STALE brings it back to RUNNING — the derivation is re-evaluated per read, not latched', async () => {
      const runId = 'stale-revived';
      const lastEventAt = await startRunningRun(runId);
      clock.current = new Date(lastEventAt.getTime() + STALE_RUN_THRESHOLD_MS + 1);
      expect((await detail(runId)).status).toBe('STALE');

      await post([
        stepStarted(runId, 'stale-revived-step', 'e-revive', '2026-08-19T10:00:05.000Z', null),
      ]);

      const revived = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(
        revived!.lastEventAt.getTime(),
        'the new event must advance lastEventAt (§13)',
      ).toBeGreaterThan(lastEventAt.getTime());
      expect(
        clock.current.getTime() - revived!.lastEventAt.getTime(),
        'fixture precondition: after the new event the run is back inside the threshold window',
      ).toBeLessThanOrEqual(STALE_RUN_THRESHOLD_MS);
      // Same clock reading as the STALE assertion above — only lastEventAt moved.
      expect((await detail(runId)).status).toBe('RUNNING');
    });
  });
});
