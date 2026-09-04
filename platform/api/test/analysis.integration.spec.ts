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
  type AnalysisRunResponse,
  type RecommendationListView,
} from '@lengentic/shared';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { AnalysisRepository } from '../src/analysis/analysis.repository';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Real-Postgres coverage for §22's `POST /v1/analysis/run` and the `GET /v1/recommendations`
 * the Recommendations page reads.
 *
 * ## Where this file came from
 *
 * The 5b wave landed the analysis endpoint with no integration spec of any kind, and the wave
 * gate's Validator wrote a throwaway probe to find out whether it worked
 * (`.artifacts/evidence/5b/validator-probe.integration.spec.ts.txt`). It did — ten of eleven
 * probes passed on a real database. The eleventh found that `GET /v1/recommendations` did not
 * exist at all, which put a 404 behind every §25 beat-4 and beat-5 line on the page. That
 * probe is adopted here rather than rewritten, because a probe the author deletes leaves no
 * regression protection behind, and extended with the list read it was written to expose.
 *
 * Two of the probe's own expectations were wrong on the first pass and the product was right
 * both times; both corrections are carried below rather than silently absorbed:
 *
 * - An under-sampled group fails THREE gates, not two — G5 also fails at `0.0% >= 80.0%` when
 *   nothing has been attested.
 * - `Run.lastEventAt` is the SERVER clock at ingest (`merge-rules.ts:220`,
 *   `Math.max(base.lastEventAt, event.receivedAt)`), not the event's `occurredAt`, so a freshly
 *   ingested run is never idle. Ageing the column directly is the only route to §39's STALE
 *   rule from a cold container.
 *
 * ## What only a real database can say
 *
 * Data is driven in exclusively through `POST /v1/telemetry/events` — the real ingest path,
 * not a repository call — so a group here is one a caller could actually produce. The read
 * ORDER assertions in particular exist nowhere else: `analysis.repository.ts` claims two
 * analysis runs over an unchanged database read the same rows in the same sequence, and that
 * claim is about what Postgres does with an `orderBy`, which no unit fake can answer.
 *
 * Same container-and-migration pattern as `telemetry.integration.spec.ts`.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../database');

const httpServer = (app: INestApplication): Server => app.getHttpServer() as Server;

type Event = Record<string, unknown>;

const RUN_ID = 'analysis-run-1';

function runStarted(runId: string, workflow: string, version: string): Event {
  return {
    eventId: `${runId}-start`,
    schemaVersion: '2',
    type: 'run.started',
    entityId: runId,
    runId,
    occurredAt: '2026-09-01T10:00:00.000Z',
    payload: { workflowName: workflow, workflowVersion: version },
  };
}

function runCompleted(runId: string): Event {
  return {
    eventId: `${runId}-complete`,
    schemaVersion: '2',
    type: 'run.completed',
    entityId: runId,
    runId,
    occurredAt: '2026-09-01T10:30:00.000Z',
    payload: { status: 'COMPLETED' },
  };
}

function decision(
  id: string,
  decisionType: string,
  contextKey: string | null,
  selectedOption: string,
  runId: string = RUN_ID,
): Event {
  return {
    eventId: `${id}-rec`,
    schemaVersion: '2',
    type: 'decision.recorded',
    entityId: id,
    runId,
    occurredAt: '2026-09-01T10:10:00.000Z',
    payload: {
      stepId: `${id}-step`,
      decisionType,
      contextKey,
      contextKeyVersion: 'v1',
      availableOptions: ['YES', 'NO'],
      selectedOption,
    },
  };
}

function attest(
  id: string,
  outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
  runId: string = RUN_ID,
): Event {
  return {
    eventId: `${id}-att`,
    schemaVersion: '2',
    type: 'decision.outcome_attested',
    entityId: id,
    runId,
    occurredAt: '2026-09-01T10:20:00.000Z',
    payload: { outcome, observedAt: '2026-09-01T10:20:00.000Z' },
  };
}

/**
 * A group the §19 gates all pass: 38 YES over 8 context keys (36 SUCCESS, 2 FAILURE) plus 2
 * NO in `post_refactor` (1 SUCCESS, 1 FAILURE). 40 samples, 9 distinct contexts, 95.0%
 * dominance, 94.7% attested success for the dominant option, 100% coverage. §20.1 finds three
 * counterexamples: the two dominant-option FAILUREs and the one minority-option SUCCESS.
 */
function candidateEvents(decisionType: string, prefix: string, runId: string = RUN_ID): Event[] {
  const events: Event[] = [];

  for (let i = 0; i < 38; i += 1) {
    events.push(
      decision(`${prefix}-yes-${String(i)}`, decisionType, `ctx_${String(i % 8)}`, 'YES', runId),
    );
    events.push(attest(`${prefix}-yes-${String(i)}`, i < 36 ? 'SUCCESS' : 'FAILURE', runId));
  }
  for (let i = 0; i < 2; i += 1) {
    events.push(decision(`${prefix}-no-${String(i)}`, decisionType, 'post_refactor', 'NO', runId));
    events.push(attest(`${prefix}-no-${String(i)}`, i === 0 ? 'SUCCESS' : 'FAILURE', runId));
  }

  return events;
}

/**
 * 30 further NO decisions in an existing group, every one attested SUCCESS: the world changing
 * under a recommendation that was already emitted. Against `candidateEvents`' 38 YES / 2 NO it
 * takes dominance from 95.0% to 54.3% and fails G3 alone — coverage stays at 100% and the
 * dominant option's own success rate does not move, so the verdict flips on one gate and
 * nothing else.
 */
function flipEvents(decisionType: string, prefix: string, runId: string = RUN_ID): Event[] {
  const events: Event[] = [];

  for (let i = 0; i < 30; i += 1) {
    events.push(
      decision(`${prefix}-${String(i)}`, decisionType, `ctx_${String(i % 8)}`, 'NO', runId),
    );
    events.push(attest(`${prefix}-${String(i)}`, 'SUCCESS', runId));
  }

  return events;
}

describe('POST /v1/analysis/run and GET /v1/recommendations against a real Postgres', () => {
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

  const analyze = async (): Promise<{ status: number; body: AnalysisRunResponse }> => {
    const response = await request(httpServer(app)).post('/v1/analysis/run').send({});
    return { status: response.status, body: response.body as AnalysisRunResponse };
  };

  const list = async (query = ''): Promise<{ status: number; body: RecommendationListView }> => {
    const response = await request(httpServer(app)).get(`/v1/recommendations${query}`);
    return { status: response.status, body: response.body as RecommendationListView };
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
      'TRUNCATE TABLE "Run", "Step", "IngestedEvent", "Decision", "Recommendation" RESTART IDENTITY CASCADE',
    );
  });

  // -------------------------------------------------------------------------
  // The negative paths first: everything that must produce NO recommendation.
  // -------------------------------------------------------------------------

  it('answers 200 with an empty evaluatedGroups over an empty database', async () => {
    const { status, body } = await analyze();

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.evaluatedGroups).toStrictEqual([]);
  });

  it('suppresses an under-sampled group, names EVERY failing gate, and persists nothing', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      decision('d-b-0', 'batch_iteration_size', 'ctx_a', 'YES'),
      decision('d-b-1', 'batch_iteration_size', 'ctx_a', 'YES'),
      decision('d-b-2', 'batch_iteration_size', 'ctx_b', 'YES'),
    ]);

    const { status, body } = await analyze();
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.evaluatedGroups).toHaveLength(1);

    const group = body.evaluatedGroups[0]!;
    expect(group.verdict).toBe('SUPPRESSED');
    expect(group.recommendationId).toBeNull();
    // §19: every failing gate, not the first. 3 < 30, 2 < 5, and nothing attested at all.
    expect(group.failedGates).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G5_outcome_coverage',
    ]);
    expect(group.gates).toHaveLength(5);

    expect(await prisma.client.recommendation.count()).toBe(0);
    expect((await list()).body.recommendations).toStrictEqual([]);
  });

  it('suppresses a single observation and leaves nothing behind it', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      decision('d-solo-0', 'single_observation', 'ctx_a', 'YES'),
    ]);

    const { status, body } = await analyze();

    expect(status).toBe(200);
    expect(body.evaluatedGroups[0]!.verdict).toBe('SUPPRESSED');
    expect(body.evaluatedGroups[0]!.recommendationId).toBeNull();
    expect(await prisma.client.recommendation.count()).toBe(0);
  });

  it('excludes every row of a RUNNING run idle past the STALE threshold and produces no candidate', async () => {
    await ingest([
      runStarted('stale-run', 'demo-workflow', 'a1b2c3d'),
      ...candidateEvents('stale_type', 'd-stale', 'stale-run'),
    ]);

    // `Run.lastEventAt` is the server clock at ingest, so an old `occurredAt` does not make a
    // run idle. Ageing the column is the only route to §39's rule from a fresh container.
    await prisma.client.run.update({
      where: { id: 'stale-run' },
      data: { lastEventAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const { status, body } = await analyze();
    expect(status, JSON.stringify(body)).toBe(200);

    // The false-positive guard: a run nobody has heard from in a day must not produce a claim.
    expect(body.evaluatedGroups.some((group) => group.verdict === 'CANDIDATE')).toBe(false);
    // The group survives with a zero denominator rather than vanishing, and G1 is what refuses it.
    expect(body.evaluatedGroups[0]?.gates[0]?.comparison).toBe('0 >= 30');
    expect(body.evaluatedGroups[0]?.verdict).toBe('SUPPRESSED');
    expect(await prisma.client.recommendation.count()).toBe(0);
  });

  it('never lets a malformed decision event reach analysis — it is rejected at ingest', async () => {
    const missingSelection = {
      eventId: 'd-bad-0-rec',
      schemaVersion: '2',
      type: 'decision.recorded',
      entityId: 'd-bad-0',
      runId: RUN_ID,
      occurredAt: '2026-09-01T10:10:00.000Z',
      payload: {
        stepId: 'd-bad-0-step',
        decisionType: 'malformed_probe',
        contextKey: 'ctx_a',
        contextKeyVersion: 'v1',
        availableOptions: ['YES', 'NO'],
      },
    };

    const response = await request(httpServer(app))
      .post('/v1/telemetry/events')
      .send({
        events: [
          runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
          runCompleted(RUN_ID),
          decision('d-good-0', 'malformed_probe', 'ctx_a', 'YES'),
          missingSelection,
        ],
      });

    expect(response.status).toBe(200);
    expect((response.body as { rejected: number }).rejected).toBe(1);

    const { status, body } = await analyze();
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.evaluatedGroups).toHaveLength(1);
    expect(body.evaluatedGroups[0]!.verdict).toBe('SUPPRESSED');
  });

  it('neither crashes nor invents a group for a keyless decision or an attestation-first row', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      // No contextKey → §18's `missingContextKey`, counted inside the group.
      decision('d-nokey-0', 'keyless_type', null, 'YES'),
      decision('d-nokey-1', 'keyless_type', 'ctx_a', 'YES'),
      // An attestation for a decision that was never recorded → a row with no decisionType.
      attest('never-recorded', 'SUCCESS'),
    ]);

    const { status, body } = await analyze();
    expect(status, JSON.stringify(body)).toBe(200);

    // One group only: the attestation-first row has no group key and must not become one.
    expect(body.evaluatedGroups.map((group) => group.groupKey.decisionType)).toStrictEqual([
      'keyless_type',
    ]);
    expect(await prisma.client.decision.count()).toBe(3);
  });

  // -------------------------------------------------------------------------
  // The positive path.
  // -------------------------------------------------------------------------

  it('turns a real 40-decision corpus into a CANDIDATE with a persisted row and its counterexamples', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('run_tests_after_code_change', 'd'),
    ]);

    const { status, body } = await analyze();
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.evaluatedGroups).toHaveLength(1);

    const group = body.evaluatedGroups[0]!;
    expect(group.verdict, JSON.stringify(group.gates)).toBe('CANDIDATE');
    expect(group.failedGates).toStrictEqual([]);
    expect(group.groupKey).toStrictEqual({
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      decisionType: 'run_tests_after_code_change',
      contextKeyVersion: 'v1',
    });
    expect(group.gates.map((gate) => gate.id)).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G3_dominance',
      'G4_outcome_success',
      'G5_outcome_coverage',
    ]);
    expect(group.recommendationId).not.toBeNull();

    const row = await prisma.client.recommendation.findUnique({
      where: { id: group.recommendationId! },
    });
    expect(row, 'the CANDIDATE named an id with no row behind it').not.toBeNull();

    // §20.1: two dominant-option FAILUREs and one minority-option SUCCESS.
    expect(row!.counterexamples).toHaveLength(3);

    const evidence = row!.evidence as Record<string, unknown>;
    expect(evidence.sampleCount).toBe(40);
    expect(evidence.distinctContextKeyCount).toBe(9);
    expect(evidence.dominantOption).toBe('YES');
  });

  it('records an EMPTY counterexamples array for a unanimous group, never an absent key', async () => {
    const events: Event[] = [runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'), runCompleted(RUN_ID)];
    // One option, every attested outcome SUCCESS: §20.1 can find neither a dominant-option
    // FAILURE nor a minority-option SUCCESS.
    for (let i = 0; i < 40; i += 1) {
      events.push(
        decision(`d-agree-${String(i)}`, 'unanimous_type', `ctx_${String(i % 8)}`, 'YES'),
      );
      events.push(attest(`d-agree-${String(i)}`, 'SUCCESS'));
    }
    await ingest(events);

    const { body } = await analyze();
    const id = body.evaluatedGroups[0]!.recommendationId!;
    const row = await prisma.client.recommendation.findUniqueOrThrow({ where: { id } });

    expect(Object.keys(row)).toContain('counterexamples');
    expect(row.counterexamples).toStrictEqual([]);

    // And on the wire, where a consumer would see it.
    const page = await list();
    expect(page.body.recommendations[0]?.counterexamples).toStrictEqual([]);
  });

  it('converges on re-analysis — §21 same fingerprint updates rather than inserting', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('idempotent_type', 'd-idem'),
    ]);

    const first = await analyze();
    const second = await analyze();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.evaluatedGroups[0]!.verdict).toBe('CANDIDATE');
    expect(second.body.evaluatedGroups[0]!.recommendationId).toBe(
      first.body.evaluatedGroups[0]!.recommendationId,
    );
    expect(await prisma.client.recommendation.count()).toBe(1);
    expect((await list()).body.recommendations).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // CANDIDATE -> SUPPRESSED. The transition, against the table.
  // -------------------------------------------------------------------------

  it('deletes the row a group left behind once its own evidence suppresses it', async () => {
    // The 5b phase gate's FINDING 1, reproduced through the real ingest path. The world
    // changes — 30 further NO decisions arrive in the same §18 group — and the group that was
    // a CANDIDATE is now refused on G3. Before this repair the row survived with the previous
    // run's evidence (OPEN, 40 samples, G3 PASS) while the response said SUPPRESSED, and
    // `GET /v1/recommendations` went on serving the superseded claim.
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('transition_type', 'd-tr'),
    ]);

    const first = await analyze();
    expect(first.body.evaluatedGroups[0]!.verdict).toBe('CANDIDATE');
    expect(await prisma.client.recommendation.count()).toBe(1);

    await ingest(flipEvents('transition_type', 'd-tr-flip'));

    const second = await analyze();
    const group = second.body.evaluatedGroups[0]!;

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    // 38 YES against 32 NO: 54.3% dominance, and nothing else moved.
    expect(group.verdict).toBe('SUPPRESSED');
    expect(group.failedGates).toStrictEqual(['G3_dominance']);
    expect(group.recommendationId).toBeNull();

    // The claim is gone from the table, not merely absent from this run's writes.
    expect(await prisma.client.recommendation.count()).toBe(0);
    expect((await list()).body.recommendations).toStrictEqual([]);
  });

  it('keeps a DISMISSED row as a tombstone, carrying the suppressing run evidence rather than the stale one', async () => {
    // `docs/decisions/0015`. Deleting it would lose §21's "DISMISSED stays DISMISSED" across a
    // suppression excursion; freezing it would leave a row serving evidence its own gates no
    // longer support, which is the defect this repair exists to remove.
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('tombstone_type', 'd-tomb'),
    ]);

    const first = await analyze();
    const id = first.body.evaluatedGroups[0]!.recommendationId!;

    const patched = await request(httpServer(app))
      .patch(`/v1/recommendations/${id}/status`)
      .send({ status: 'DISMISSED', note: 'known trade-off' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const dismissed = await prisma.client.recommendation.findUniqueOrThrow({ where: { id } });

    await ingest(flipEvents('tombstone_type', 'd-tomb-flip'));

    const second = await analyze();
    expect(second.body.evaluatedGroups[0]!.verdict).toBe('SUPPRESSED');
    expect(second.body.evaluatedGroups[0]!.recommendationId).toBeNull();

    const kept = await prisma.client.recommendation.findUnique({ where: { id } });
    expect(
      kept,
      'the dismissal was deleted by an analysis run that has no opinion about it',
    ).not.toBeNull();
    expect(kept!.status).toBe('DISMISSED');
    expect(kept!.statusNote).toBe('known trade-off');
    expect(kept!.statusChangedAt).toStrictEqual(dismissed.statusChangedAt);
    expect(kept!.firstSeenAt).toStrictEqual(dismissed.firstSeenAt);

    // The refresh: 70 samples and a FAILING G3, not the 40 samples and the PASS it was
    // dismissed over. A tombstone still serving the old evidence is the same defect with a
    // different status column.
    const evidence = kept!.evidence as {
      sampleCount: number;
      dominancePercentage: number;
      gates: { id: string; status: string }[];
    };
    expect(evidence.sampleCount).toBe(70);
    expect(evidence.dominancePercentage).toBeLessThan(0.9);
    expect(evidence.gates.find((gate) => gate.id === 'G3_dominance')?.status).toBe('FAIL');

    // And on the wire, where §25 beat 4 renders it. The row is still listed — hiding it would
    // hide the counterevidence it was dismissed over.
    const page = await list();
    expect(page.body.recommendations).toHaveLength(1);
    expect(page.body.recommendations[0]?.status).toBe('DISMISSED');
    expect(page.body.recommendations[0]?.evidence.sampleCount).toBe(70);
  });

  // -------------------------------------------------------------------------
  // The wire fields §25 renders off the analysis response.
  // -------------------------------------------------------------------------

  it('carries dominantOptionAttestedSuccessRate as null when nothing is attested for the dominant option', async () => {
    // The `N/A` Definition-of-Done line has no other live path: the null forces G4
    // NOT_APPLICABLE, which caps coverage at the minority share, which fails G5 and suppresses
    // the group — and a SUPPRESSED group persists no row. 36 unattested YES over seven
    // contexts plus 4 attested NO in `cold_start`, which is Tester's own construction.
    const events: Event[] = [runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'), runCompleted(RUN_ID)];
    for (let i = 0; i < 36; i += 1) {
      events.push(
        decision(`d-na-yes-${String(i)}`, 'nothing_attested', `ctx_${String(i % 7)}`, 'YES'),
      );
    }
    for (let i = 0; i < 4; i += 1) {
      events.push(decision(`d-na-no-${String(i)}`, 'nothing_attested', 'cold_start', 'NO'));
      events.push(attest(`d-na-no-${String(i)}`, 'SUCCESS'));
    }
    await ingest(events);

    const { status, body } = await analyze();
    const group = body.evaluatedGroups[0]!;

    expect(status, JSON.stringify(body)).toBe(200);
    expect(group.verdict).toBe('SUPPRESSED');
    expect(group.failedGates).toStrictEqual(['G5_outcome_coverage']);
    expect(group.gates.find((gate) => gate.id === 'G4_outcome_success')?.status).toBe(
      'NOT_APPLICABLE',
    );
    // The field itself: 0 occurrences in the live analysis response before this repair.
    expect(group.dominantOptionAttestedSuccessRate).toBeNull();
    expect(await prisma.client.recommendation.count()).toBe(0);
  });

  it('carries the rate as a number when the dominant option does have attested outcomes', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('rate_type', 'd-rate'),
    ]);

    const { body } = await analyze();

    // 36 of 38 dominant-option outcomes attested SUCCESS — the same number G4 compares.
    expect(body.evaluatedGroups[0]!.dominantOptionAttestedSuccessRate).toBeCloseTo(36 / 38, 10);
  });

  // -------------------------------------------------------------------------
  // §22 takes no parameters — including no body at all.
  // -------------------------------------------------------------------------

  it('accepts a parameterless POST — no content-type, no body — as §22 documents it', async () => {
    // `curl -X POST http://localhost:3011/v1/analysis/run`, the plainest invocation of an
    // endpoint documented as taking no parameters, answered 400 before this repair (Tester,
    // FINDING 4). The Dashboard was unaffected because it sends `{}` with a JSON content-type,
    // so nothing on the UI path could have caught it.
    const response = await request(httpServer(app)).post('/v1/analysis/run');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as AnalysisRunResponse).evaluatedGroups).toStrictEqual([]);
  });

  it('still refuses a body that is not an object — "no parameters" is not "anything goes"', async () => {
    const array = await request(httpServer(app))
      .post('/v1/analysis/run')
      .set('content-type', 'application/json')
      .send('[]');

    expect(array.status).toBe(400);
  });

  it('reaches §21 PATCH through the module graph AnalysisModule imports', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('patch_type', 'd-patch'),
    ]);

    const { body } = await analyze();
    const id = body.evaluatedGroups[0]!.recommendationId!;

    const patched = await request(httpServer(app))
      .patch(`/v1/recommendations/${id}/status`)
      .send({ status: 'DISMISSED', note: 'known trade-off' });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as { status: string }).status).toBe('DISMISSED');
  });

  // -------------------------------------------------------------------------
  // GET /v1/recommendations — §25 beats 4 and 5's only content path.
  // -------------------------------------------------------------------------

  it('answers the list read with the frozen envelope over an empty database', async () => {
    const { status, body } = await list();

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toStrictEqual({ recommendations: [], limit: 50, offset: 0, hasMore: false });
  });

  it('serves a page the Dashboard own contract parses, with the evidence §25 renders', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('run_tests_after_code_change', 'd'),
    ]);
    await analyze();

    const { status, body } = await list();

    expect(status, JSON.stringify(body)).toBe(200);

    // Parsed with the same schema `recommendations-api.ts` uses, so "the Dashboard can read
    // this" is checked rather than argued.
    const parsed = RecommendationListViewSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    const recommendation = parsed.data!.recommendations[0]!;

    expect(recommendation.category).toBe('DETERMINISTIC_CANDIDATE');
    expect(recommendation.analyzerId).toBe('deterministic-candidate');
    expect(recommendation.analyzerVersion).toBe('1.0.0');
    expect(recommendation.status).toBe('OPEN');
    expect(recommendation.groupKey.decisionType).toBe('run_tests_after_code_change');
    // §25 beat 4's numbers reach the browser through this read and no other.
    expect(recommendation.evidence.sampleCount).toBe(40);
    expect(recommendation.evidence.distinctContextKeyCount).toBe(9);
    expect(recommendation.evidence.dominantOption).toBe('YES');
    expect(recommendation.evidence.gates).toHaveLength(5);
    expect(recommendation.evidence.minorityContextConcentration).not.toStrictEqual([]);
    // §25 beat 5: counterexamples included.
    expect(recommendation.counterexamples).toHaveLength(3);
    // §21's `sourceWatermark` and the fingerprint survive the round trip as readable values.
    expect(recommendation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(recommendation.sourceWatermark)).not.toBeNaN();
  });

  it('keeps a DISMISSED recommendation in the list — hiding it would hide the evidence it was dismissed over', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('dismissed_type', 'd-dis'),
    ]);
    const { body } = await analyze();
    const id = body.evaluatedGroups[0]!.recommendationId!;

    await request(httpServer(app))
      .patch(`/v1/recommendations/${id}/status`)
      .send({ status: 'DISMISSED', note: 'known trade-off' });

    const page = await list();

    expect(page.body.recommendations).toHaveLength(1);
    expect(page.body.recommendations[0]?.status).toBe('DISMISSED');
    expect(page.body.recommendations[0]?.statusNote).toBe('known trade-off');
  });

  it('paginates, and says so — a short page a caller was not told about is a lost recommendation', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      ...candidateEvents('first_type', 'd-one'),
      ...candidateEvents('second_type', 'd-two'),
    ]);
    await analyze();

    expect(await prisma.client.recommendation.count()).toBe(2);

    const firstPage = await list('?limit=1');
    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    expect(firstPage.body.recommendations).toHaveLength(1);
    expect(firstPage.body.limit).toBe(1);
    expect(firstPage.body.offset).toBe(0);
    expect(firstPage.body.hasMore).toBe(true);

    const secondPage = await list('?limit=1&offset=1');
    expect(secondPage.body.recommendations).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);

    // Two disjoint pages, not the same row twice — which is what the id tie-break in the
    // repository's `orderBy` is for.
    expect(secondPage.body.recommendations[0]?.id).not.toBe(firstPage.body.recommendations[0]?.id);

    const wholeList = await list('?limit=50');
    expect(wholeList.body.recommendations).toHaveLength(2);
    expect(wholeList.body.hasMore).toBe(false);
  });

  it('rejects an oversized limit rather than silently clamping it (API-4)', async () => {
    const response = await request(httpServer(app)).get('/v1/recommendations?limit=5000');

    expect(response.status, JSON.stringify(response.body)).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Read-order stability — a claim about Postgres that no unit fake can answer.
  // -------------------------------------------------------------------------

  it('reads decisions in a stable total order, independent of the order they were written', async () => {
    await ingest([
      runStarted(RUN_ID, 'demo-workflow', 'a1b2c3d'),
      runCompleted(RUN_ID),
      decision('d-w', 'order_type', 'ctx_a', 'YES'),
      decision('d-x', 'order_type', 'ctx_a', 'YES'),
      decision('d-y', 'order_type', 'ctx_a', 'YES'),
      decision('d-z', 'order_type', 'ctx_a', 'YES'),
    ]);

    // Insertion order is w, x, y, z. `createdAt` is forced into a different order, and two
    // rows are given the SAME instant so the `id` tie-break is the only thing that can
    // separate them. Heap order now agrees with neither, so a read that returns the expected
    // sequence did so because of the `orderBy` and not by accident.
    const early = new Date('2026-09-01T00:00:00.000Z');
    const late = new Date('2026-09-02T00:00:00.000Z');
    await prisma.client.decision.update({ where: { id: 'd-w' }, data: { createdAt: late } });
    await prisma.client.decision.update({ where: { id: 'd-x' }, data: { createdAt: early } });
    await prisma.client.decision.update({ where: { id: 'd-y' }, data: { createdAt: late } });
    await prisma.client.decision.update({ where: { id: 'd-z' }, data: { createdAt: early } });

    const repository = app.get(AnalysisRepository);

    const first = await repository.listDecisionsForAnalysis();
    const second = await repository.listDecisionsForAnalysis();

    // Oldest first, then id ascending: (early, d-x), (early, d-z), (late, d-w), (late, d-y).
    expect(first.map((source) => source.decisionId)).toStrictEqual(['d-x', 'd-z', 'd-w', 'd-y']);
    // Two runs over an unchanged database read the same rows in the same sequence — the
    // property that makes a re-run comparable.
    expect(second.map((source) => source.decisionId)).toStrictEqual(
      first.map((source) => source.decisionId),
    );
  });
});
