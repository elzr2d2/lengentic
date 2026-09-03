import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Server } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryRepository } from '../src/telemetry/telemetry.repository';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { DecisionsRepository } from '../src/decisions/decisions.repository';
import { DecisionsService } from '../src/decisions/decisions.service';
import { ModelCallRepository } from '../src/model-call/model-call.repository';
import { ModelCallService } from '../src/model-call/model-call.service';
import { ToolCallRepository } from '../src/tool-call/tool-call.repository';
import { ToolCallService } from '../src/tool-call/tool-call.service';
import { ErrorRepository } from '../src/error/error.repository';
import { ErrorService } from '../src/error/error.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import type { Env } from '../src/config/env.schema';
import type { IngestResponse } from '@lengentic/shared';

/**
 * Real-Postgres regression coverage for `p2.ingest-endpoint`, carried across two repair
 * attempts:
 *
 * - F1 (2026-08-19, repair attempt 1): concurrent writes to the same entity silently lost
 *   one side of the merge. The unit suite mocks `TelemetryRepository`, so it cannot see a
 *   race that only exists between two real database connections — this file is the only
 *   place that claim can be tested.
 * - F2 (2026-08-19, repair attempt 1): a U+0000 / lone-surrogate value in an event payload is
 *   valid per every Zod schema but Postgres rejects it at the wire level. Only a real
 *   `jsonb` column can prove the rejection actually happens, and that it happens as a
 *   per-event REJECTED, not a thrown exception.
 * - D3 (2026-08-20, repair attempt 2, tester re-verification): repair attempt 1 replaced the
 *   start-side merge's wholesale-replace with a presence-based merge to stop a
 *   metadata-less winner from blanking a prior winner's metadata — and that merge turned out
 *   to be arrival-order dependent (same event set, different persisted `metadata` depending
 *   on processing/request order), which is worse than the symptom it fixed and violates ADR
 *   0007's Consequences. Reverted to wholesale replace in `merge-rules.ts`; this file proves
 *   the revert holds across real request boundaries, not only in-process permutations
 *   (`merge-rules.spec.ts` covers those).
 * - D2 (2026-08-20, repair attempt 2, tester re-verification): each entity group is its own
 *   transaction; a throw partway through a batch (Postgres rejecting an out-of-range
 *   `occurredAt`, or `mergeEvent`'s `structuredClone` overflowing the call stack on a
 *   pathologically deep `metadata`) used to propagate out of `TelemetryService.ingest`
 *   uncaught — HTTP 500, zero per-event results, even for groups that had already committed.
 *   `TelemetryService.ingest` now contains a group's failure to that group; this file proves
 *   it against two real failure origins (a Postgres constraint at save time, and a
 *   `RangeError` inside the fold itself), not a mocked throw.
 *
 * F3 in the tester-reverify sense (§12's dedup ledger gap — a re-posted eventId that never
 * became a per-key/per-event winner is misclassified ACCEPTED) is NOT fixed by anything in
 * this file. It was deferred to `p2.idempotency` by human ruling
 * (`.artifacts/evidence/2/f3-ruling.md`) and ADR 0009, which built ADR 0005 §1's
 * `IngestedEvent` ledger. The last test below WAS the standing red documenting that gap; it
 * is now the regression test for its closure, and asserts the ledger row rather than only
 * the reported status. `p2.integration-tests` flipped it on 2026-08-21.
 *
 * Same container-and-migration pattern as `health.integration.spec.ts`, plus applying the
 * real `@lengentic/database` migrations (`prisma migrate deploy`) since this file talks to
 * `Run`/`Step` tables directly rather than only exercising `/health`.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../database');

function serviceAgainst(connectionString: string): PrismaService {
  const config = { get: () => connectionString } as unknown as ConfigService<Env, true>;
  return new PrismaService(config);
}

async function newTrio(connectionString: string): Promise<{
  prisma: PrismaService;
  repository: TelemetryRepository;
  service: TelemetryService;
}> {
  const prisma = serviceAgainst(connectionString);
  await prisma.onModuleInit();
  const repository = new TelemetryRepository(prisma);
  // ADR 0014: the real modules, against the same live Postgres connection, so a batch that
  // mixes Run/Step events with the four Phase 4 entity types exercises the actual seam —
  // group-locked Run/Step writes AND independent entity upserts sharing one transaction-less
  // request the way `TelemetryService.ingest` really composes them.
  const service = new TelemetryService(
    repository,
    new DecisionsService(new DecisionsRepository(prisma)),
    new ModelCallService(new ModelCallRepository(prisma)),
    new ToolCallService(new ToolCallRepository(prisma)),
    new ErrorService(new ErrorRepository(prisma)),
  );
  return { prisma, repository, service };
}

function runStartedEvent(
  entityId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: `${entityId}-start`,
    schemaVersion: '1',
    type: 'run.started',
    entityId,
    runId: entityId,
    occurredAt: '2026-08-19T10:00:00.000Z',
    payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    ...overrides,
  };
}

function runCompletedEvent(
  entityId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: `${entityId}-complete`,
    schemaVersion: '1',
    type: 'run.completed',
    entityId,
    runId: entityId,
    occurredAt: '2026-08-19T10:05:00.000Z',
    payload: { status: 'COMPLETED' },
    ...overrides,
  };
}

describe('Telemetry ingestion against a real Postgres (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    connectionString = container.getConnectionUri();

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DATABASE_DIR,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  describe('F1: concurrent writes to the same entity must not lose either side of the merge', () => {
    it('a concurrent start and completion for the same Run, from two independent connections, both land', async () => {
      // Two independent PrismaService instances — two separate connection pools, standing
      // in for two API replicas. An in-process mutex would not close this race; only a
      // database-level lock (this fix uses a transaction-scoped advisory lock) does.
      const replicaA = await newTrio(connectionString);
      const replicaB = await newTrio(connectionString);

      try {
        const TRIALS = 15;
        const entityIds = Array.from({ length: TRIALS }, (_, i) => `race-run-${i}`);

        await Promise.all(
          entityIds.flatMap((entityId) => [
            replicaA.service.ingest([runStartedEvent(entityId)]),
            replicaB.service.ingest([runCompletedEvent(entityId)]),
          ]),
        );

        for (const entityId of entityIds) {
          const state = await replicaA.repository.loadRun(entityId);
          expect(state, `entity ${entityId} was never persisted at all`).toBeDefined();
          // Both sides of the merge must be visible — a lost update drops one of these two.
          expect(state?.startedAt, `${entityId}: start side was lost`).not.toBeNull();
          // `toMatchObject`, not `toEqual`: RunStartedPayloadSchema's nullish `metadata`
          // rehydrates as an explicit `metadata: null` key alongside the two asserted here,
          // which is correct and irrelevant to what this test is checking.
          expect(state?.startFields, `${entityId}: start side was lost`).toMatchObject({
            workflowName: 'wf',
            workflowVersion: '1.0.0',
          });
          expect(state?.completedAt, `${entityId}: completion side was lost`).not.toBeNull();
          expect(state?.status, `${entityId}: completion side was lost`).toBe('COMPLETED');
        }
      } finally {
        await replicaA.prisma.onModuleDestroy();
        await replicaB.prisma.onModuleDestroy();
      }
    }, 60_000);

    it('two concurrent batches each starting AND completing the same never-before-seen Run both survive (races on the very first write, not just an update)', async () => {
      // The advisory lock is acquired before the row is read, unconditionally — this is the
      // case `SELECT ... FOR UPDATE` alone cannot close, since there is nothing to lock yet.
      const replicaA = await newTrio(connectionString);
      const replicaB = await newTrio(connectionString);

      try {
        const entityId = 'race-run-first-write';
        const batchA = [
          runStartedEvent(entityId, { eventId: 'a-start' }),
          runCompletedEvent(entityId, {
            eventId: 'a-complete',
            occurredAt: '2026-08-19T10:05:00.000Z',
          }),
        ];
        const batchB = [
          runStartedEvent(entityId, {
            eventId: 'b-start',
            occurredAt: '2026-08-19T09:59:00.000Z', // earlier — should win first-writer-wins
          }),
        ];

        const [responseA, responseB] = await Promise.all([
          replicaA.service.ingest(batchA),
          replicaB.service.ingest(batchB),
        ]);

        // Neither request throws, and neither silently drops an event of its own.
        expect(responseA.results.every((r) => r.status !== 'REJECTED')).toBe(true);
        expect(responseB.results.every((r) => r.status !== 'REJECTED')).toBe(true);

        const state = await replicaA.repository.loadRun(entityId);
        expect(state).toBeDefined();
        // Completion from batch A must survive regardless of interleaving.
        expect(state?.status).toBe('COMPLETED');
        expect(state?.completedAt).toBe('2026-08-19T10:05:00.000Z');
        // The earlier-occurring start (batch B) must win first-writer-wins over batch A's
        // later-occurring start, exactly as merge-rules.ts specifies — a lost update could
        // just as easily manifest as the WRONG winner surviving as no winner at all.
        expect(state?.startedAt).toBe('2026-08-19T09:59:00.000Z');
      } finally {
        await replicaA.prisma.onModuleDestroy();
        await replicaB.prisma.onModuleDestroy();
      }
    }, 60_000);
  });

  describe('F2: malformed unicode is an event-level rejection, never a thrown exception', () => {
    it('a lone surrogate in metadata is REJECTED (INVALID_PAYLOAD); a good sibling event in the same batch still lands', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const goodEntityId = 'unicode-good-run';
        const badEntityId = 'unicode-bad-run';
        const loneSurrogate = '\uD800'; // the truncated-emoji shape §12 warns about

        const response = await service.ingest([
          runStartedEvent(goodEntityId),
          runStartedEvent(badEntityId, {
            payload: {
              workflowName: 'wf',
              workflowVersion: '1.0.0',
              metadata: { note: `bad${loneSurrogate}value` },
            },
          }),
        ]);

        expect(response.rejected).toBe(1);
        expect(response.accepted).toBe(1);
        expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
        // The good event in the same batch is untouched — one bad event never discards it,
        // and the request as a whole never throws (this whole `it` would have failed on the
        // `await` above if it had).
        expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });

        const goodState = await repository.loadRun(goodEntityId);
        expect(goodState?.startedAt).not.toBeNull();
        const badState = await repository.loadRun(badEntityId);
        expect(badState, 'the rejected event must never reach Postgres').toBeUndefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('a bare NUL byte in metadata is REJECTED the same way', async () => {
      const { service, prisma } = await newTrio(connectionString);
      try {
        const response = await service.ingest([
          runStartedEvent('unicode-nul-run', {
            payload: {
              workflowName: 'wf',
              workflowVersion: '1.0.0',
              metadata: { note: 'bad value' },
            },
          }),
        ]);

        expect(response.results[0]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('D3: start-side merge stays a pure function of the event set across real request boundaries', () => {
    it("a winning-but-metadata-less start event WHOLESALE REPLACES the prior winner's fields, round-tripped through real Postgres (D3: presence-merge reverted — see merge-rules.ts)", async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const entityId = 'metadata-preserve-run';

        await service.ingest([
          runStartedEvent(entityId, {
            eventId: 'evt-with-metadata',
            occurredAt: '2026-08-19T10:00:00.000Z',
            payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: { tenant: 'acme' } },
          }),
        ]);

        // Earlier occurredAt — wins first-writer-wins and becomes the new startEventId — but
        // its own payload never carries metadata. Repair attempt 1 merged this event's
        // fields onto the previous winner's so `metadata` survived; that design turned out to
        // be arrival-order dependent (tester finding D3) and was reverted. Wholesale replace
        // means the prior winner's metadata is dropped here, deliberately.
        await service.ingest([
          runStartedEvent(entityId, {
            eventId: 'evt-no-metadata',
            occurredAt: '2026-08-19T09:00:00.000Z',
            payload: { workflowName: 'wf-v2', workflowVersion: '2.0.0' },
          }),
        ]);

        const state = await repository.loadRun(entityId);
        expect(state?.startEventId).toBe('evt-no-metadata');
        // `metadata: null` is the honest persisted value, not an omission — the repository
        // always reports the column (`runRowToState`), never an absent key.
        expect(state?.startFields).toEqual({
          workflowName: 'wf-v2',
          workflowVersion: '2.0.0',
          metadata: null,
        });
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('D3: the same three-event set persists an IDENTICAL final row whether posted as three separate requests or as one batch, in either order (mutation-check: this is exactly the shape that split 17/13 under the reverted presence-merge)', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        // s2 and s3 tie at the same occurredAt; 's2' < 's3' lexicographically so s2 wins the
        // tie AND has the earliest occurredAt overall — s2 is the entity's start winner no
        // matter what order these three arrive in. s2 itself never carries metadata; s1 and
        // s3 do. A design that merges onto residual state (the reverted one) leaks s1's or
        // s3's metadata onto the winner depending on order; wholesale replace never does.
        const mkSet = (entityId: string) => [
          runStartedEvent(entityId, {
            eventId: `${entityId}-s1`,
            occurredAt: '2026-08-19T10:00:05.000Z',
            payload: { workflowName: 'wf-s1', workflowVersion: 'v-s1', metadata: { from: 's1' } },
          }),
          runStartedEvent(entityId, {
            eventId: `${entityId}-s2`,
            occurredAt: '2026-08-19T10:00:03.000Z',
            payload: { workflowName: 'wf-s2', workflowVersion: 'v-s2' },
          }),
          runStartedEvent(entityId, {
            eventId: `${entityId}-s3`,
            occurredAt: '2026-08-19T10:00:03.000Z',
            payload: { workflowName: 'wf-s3', workflowVersion: 'v-s3', metadata: { from: 's3' } },
          }),
        ];

        const separateRequestsEntity = 'ord-separate-requests';
        for (const event of mkSet(separateRequestsEntity)) {
          await service.ingest([event]);
        }

        const oneBatchForwardEntity = 'ord-one-batch-forward';
        await service.ingest(mkSet(oneBatchForwardEntity));

        const oneBatchReversedEntity = 'ord-one-batch-reversed';
        await service.ingest([...mkSet(oneBatchReversedEntity)].reverse());

        const expected = {
          startEventId: `-s2`, // suffix-checked below per entity
          startedAt: '2026-08-19T10:00:03.000Z',
          // `metadata: null` is the honest persisted value (the column is always reported),
          // not an omission — s2 never carried metadata and wholesale replace never
          // backfills it from s1 or s3, regardless of arrival order.
          startFields: { workflowName: 'wf-s2', workflowVersion: 'v-s2', metadata: null },
        };

        for (const entityId of [
          separateRequestsEntity,
          oneBatchForwardEntity,
          oneBatchReversedEntity,
        ]) {
          const state = await repository.loadRun(entityId);
          expect(state?.startEventId, entityId).toBe(`${entityId}${expected.startEventId}`);
          expect(state?.startedAt, entityId).toBe(expected.startedAt);
          expect(state?.startFields, entityId).toEqual(expected.startFields);
        }
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('D2 / ADR 0010: a bad occurredAt is an event-level rejection; a genuine persistence failure is a 5xx, never an event-level REJECTED', () => {
    it('year-0000 occurredAt (would be Postgres SQLSTATE 22008) is caught event-level before it ever reaches a group — well-formed groups either side still commit', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const response = await service.ingest([
          runStartedEvent('d2-good-before'),
          runStartedEvent('d2-bad-year-zero', {
            eventId: 'd2-bad-year-zero-start',
            occurredAt: '0000-01-01T00:00:00.000Z',
          }),
          runStartedEvent('d2-good-after'),
        ]);

        // Every event gets a result, and the response is a plain 200 — the year-0000 event
        // never reaches persistence at all (ADR 0010 supersedes the PROCESSING_FAILED design
        // tester findings T2/T3 rejected: this is now INVALID_PAYLOAD, event-level).
        expect(response.results).toHaveLength(3);
        expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
        expect(response.results[2]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.accepted).toBe(2);
        expect(response.rejected).toBe(1);

        expect((await repository.loadRun('d2-good-before'))?.startedAt).not.toBeNull();
        expect((await repository.loadRun('d2-good-after'))?.startedAt).not.toBeNull();
        expect(await repository.loadRun('d2-bad-year-zero')).toBeUndefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('1 malformed (year-0000) + 99 well-formed events for the SAME entity: the 99 persist as one row, only the malformed one is rejected (MVP_PLAN_V3.md:1611)', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const entityId = 'd2-scale-run';
        const events = Array.from({ length: 99 }, (_, i) =>
          runStartedEvent(entityId, {
            eventId: `${entityId}-s${i}`,
            occurredAt: `2026-08-19T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
          }),
        );
        events.splice(
          50,
          0,
          runCompletedEvent(entityId, {
            eventId: `${entityId}-poison`,
            occurredAt: '0000-01-01T00:00:00.000Z',
          }),
        );

        const response = await service.ingest(events);

        expect(response.accepted).toBe(99);
        expect(response.rejected).toBe(1);
        expect(response.results.find((r) => r.eventId === `${entityId}-poison`)).toMatchObject({
          status: 'REJECTED',
          error: { code: 'INVALID_PAYLOAD' },
        });

        const row = await repository.loadRun(entityId);
        expect(row?.startedAt).not.toBeNull();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    // F-7 (tester finding, 2026-08-20, repair attempt 3): the PREVIOUS version of this test
    // asserted the FORBIDDEN behaviour — `.rejects.toThrow()` on a single depth-3000 fixture,
    // i.e. it pinned in "a deep metadata object throws and loses its sibling", exactly what
    // ADR 0010's Detection section (T5) forbids: "no input shape produces a 500 with zero
    // per-event results." It also only ever probed ONE depth, while the underlying defect
    // (F-1/F-3/F-6) was that the fix which closed T5 for one repair attempt's fixture left a
    // BAND of other depths (1500-9000) still throwing — a green that lied twice over. This
    // replacement sweeps that band, reproduced from the tester's own fixture
    // (`.artifacts/evidence/2/tester-human-repair/raw/t5-sweep.txt`), plus the values on
    // either side of it, and asserts the boundary ADR 0010 actually states: every depth is
    // either accepted or REJECTED event-level, never a throw.
    it('a pathologically deep, Zod-legal metadata object is REJECTED event-level across the whole depth range that used to escape containment — never a throw from inside the fold (tester findings F-1/F-3/F-6, 2026-08-20, repair attempt 3)', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const depths = [200, 1000, 1500, 3000, 6000, 9000, 10000, 15000, 25000];

        for (const depth of depths) {
          let deeplyNested: unknown = { v: 1 };
          for (let i = 0; i < depth; i++) {
            deeplyNested = { child: deeplyNested };
          }

          const goodEntityId = `d2-sweep-good-${depth}`;
          const badEntityId = `d2-sweep-bad-${depth}`;

          // Each depth gets its OWN entity pair (own groups) — one poison event must never
          // affect another depth's result, and Map iteration order (insertion order) means
          // the good group's transaction is attempted before the bad one's either way.
          const response = await service.ingest([
            runStartedEvent(goodEntityId),
            runStartedEvent(badEntityId, {
              eventId: `${badEntityId}-start`,
              payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: deeplyNested },
            }),
          ]);

          expect(response.results, `depth ${depth}`).toHaveLength(2);
          expect(response.results[0], `depth ${depth}`).toMatchObject({ status: 'ACCEPTED' });
          expect(response.results[1], `depth ${depth}`).toMatchObject({ status: 'REJECTED' });
          expect(response.results[1]?.error?.code, `depth ${depth}`).toBe('INVALID_PAYLOAD');

          expect(
            (await repository.loadRun(goodEntityId))?.startedAt,
            `depth ${depth}: good sibling`,
          ).not.toBeNull();
          expect(await repository.loadRun(badEntityId), `depth ${depth}: poison`).toBeUndefined();
        }
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 60_000);

    it('an occurredAt whose literal year reads 0001 but whose UTC-shifted instant lands in year 0000 is caught the same way as a literal 0000 — the offset bypass (tester finding F-3, 2026-08-20, repair attempt 3)', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const response = await service.ingest([
          runStartedEvent('d2-good-before-offset'),
          runStartedEvent('d2-bad-offset-year-zero', {
            eventId: 'd2-bad-offset-year-zero-start',
            // Literal year reads 0001; UTC instant is 0000-12-31T19:00:00.000Z — confirmed
            // live to raise Postgres SQLSTATE 22008, the same as a literal year-0000 value
            // (`.artifacts/evidence/2/tester-human-repair/raw/pg-22008-observed.txt`). The
            // FIRST fix here compared the literal wire text and let this straight through.
            occurredAt: '0001-01-01T00:00:00.000+05:00',
          }),
          runStartedEvent('d2-good-after-offset'),
        ]);

        expect(response.results).toHaveLength(3);
        expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
        expect(response.results[2]).toMatchObject({ status: 'ACCEPTED' });

        expect((await repository.loadRun('d2-good-before-offset'))?.startedAt).not.toBeNull();
        expect((await repository.loadRun('d2-good-after-offset'))?.startedAt).not.toBeNull();
        expect(await repository.loadRun('d2-bad-offset-year-zero')).toBeUndefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('F3 in the tester-reverify sense (§12 dedup ledger gap): closed by the IngestedEvent ledger p2.idempotency built, ADR 0009', () => {
    it('reposting the WINNING start eventId across two requests is DUPLICATE, not a second ACCEPTED', async () => {
      const { service, prisma } = await newTrio(connectionString);
      try {
        const entityId = 'dedup-winner-run';
        const event = runStartedEvent(entityId, { eventId: 'evt-winner' });

        const first = await service.ingest([event]);
        const second = await service.ingest([{ ...event }]);

        expect(first.results[0]).toMatchObject({ status: 'ACCEPTED' });
        expect(second.results[0]).toMatchObject({ status: 'DUPLICATE' });
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('reposting a start eventId that LOST the tie-break across two requests is DUPLICATE — the IngestedEvent ledger records losers, not only winners (ADR 0009 A-7)', async () => {
      // Flipped by `p2.integration-tests`, 2026-08-21. This case was RED-as-documentation
      // for two sessions: under the entity-state-derived interim only the WINNING start
      // event's id survived across requests (`startEventId`, one column), so a re-posted
      // loser was re-classified ACCEPTED forever. `p2.idempotency` closed that gap by
      // building ADR 0005 §1's `IngestedEvent` ledger — which is why the assertion below is
      // on the LEDGER as well as on the status. A status assertion alone would go green
      // again on a re-introduced provenance derivation that happened to guess right for one
      // event; the ledger row is the thing that makes the DUPLICATE true.
      //
      // ADR 0009's own Detection fixture — the four-event D2.2 replay asserting
      // `accepted:0, duplicate:4` — lives in `run-lifecycle.integration.spec.ts`, this
      // lane's own file. This test keeps the narrower loser-specific case where the gap was
      // first observed.
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const entityId = 'dedup-loser-run';

        // First request: two start events for a never-before-seen entity. The earlier
        // occurredAt (evt-early) wins startEventId; evt-late loses and, before the ledger
        // existed, left no trace of its own anywhere.
        const first = await service.ingest([
          runStartedEvent(entityId, {
            eventId: 'evt-late',
            occurredAt: '2026-08-19T10:00:00.000Z',
          }),
          runStartedEvent(entityId, {
            eventId: 'evt-early',
            occurredAt: '2026-08-19T09:00:00.000Z',
          }),
        ]);
        expect(first.results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);

        const before = await repository.loadRun(entityId);
        expect(before?.startEventId).toBe('evt-early');

        // The loser is on the ledger even though it owns no column on the row. This is the
        // assertion that distinguishes a real ledger from entity-state provenance.
        const ledgerAfterFirst = await prisma.client.ingestedEvent.findMany({
          where: { runId: entityId },
          select: { eventId: true },
        });
        expect(ledgerAfterFirst.map((row) => row.eventId).sort()).toEqual([
          'evt-early',
          'evt-late',
        ]);

        // Second, separate request: repost the LOSING event from the first request.
        const second = await service.ingest([
          runStartedEvent(entityId, {
            eventId: 'evt-late',
            occurredAt: '2026-08-19T10:00:00.000Z',
          }),
        ]);

        // §12: "Re-posting a known eventId is a no-op." Known means known, not known-and-won.
        expect(second.results[0]).toMatchObject({ status: 'DUPLICATE' });
        expect({ accepted: second.accepted, duplicate: second.duplicate }).toEqual({
          accepted: 0,
          duplicate: 1,
        });

        // No new row, state unchanged (still evt-early's fields as the winner), and the
        // replay did not append a second ledger entry for the same (runId, eventId).
        const after = await repository.loadRun(entityId);
        expect(after?.startEventId).toBe('evt-early');
        expect(after?.startedAt).toBe(before?.startedAt);
        expect(await prisma.client.ingestedEvent.count({ where: { runId: entityId } })).toBe(2);
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });
});

/**
 * ADR 0010 (`docs/decisions/0010-infrastructure-failure-is-not-an-event-level-rejection.md`),
 * tester findings T1/T4/T5, 2026-08-20 — proven through the REAL HTTP boundary (real Nest
 * routing, the real `zodBody`/`IngestRequestSchema` pipe, the real `TelemetryService` and
 * `TelemetryRepository`, the real `AllExceptionsFilter`, real supertest requests over a real
 * `http.Server`), not by calling `TelemetryService` directly. The tester's own
 * re-verification flagged that gap explicitly: "The committed integration suite drives `new
 * TelemetryService(...)` directly — it never crosses the HTTP controller... which is where
 * the HTTP-status findings come from."
 *
 * Deliberately NOT the full `AppModule` `health.integration.spec.ts` uses: `AppModule` wires
 * `nestjs-pino`'s `LoggerModule`, and pino's `fast-safe-stringify` serializer independently
 * stack-overflows (`RangeError` inside `decirc`) on a request this large even at `LOG_LEVEL`
 * `fatal` — a pre-existing logging-infrastructure gap, not a regression this repair
 * introduces or T1/T5 asks it to fix (`platform/api/src/app.module.ts`'s `LoggerModule` is
 * unmodified, and no `PROCESSING_FAILED`-style catch swallows it — pino's own serializer
 * throws before this test's assertions ever run). This module hand-assembles the same
 * request pipeline `main.ts` builds (`ConfigModule`, `PrismaModule`, `TelemetryModule`,
 * `configureBodyParser`, `AllExceptionsFilter`, the `v1` prefix) minus that one module, so
 * the boundary under test — routing, validation, the service, the filter — is identical.
 */
describe('POST /v1/telemetry/events — ADR 0010 at the real HTTP boundary', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;

  const httpServer = (a: INestApplication): Server => a.getHttpServer() as Server;

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

    const [{ ConfigModule }, { PrismaModule }, { TelemetryModule }, { validateEnv }] =
      await Promise.all([
        import('@nestjs/config'),
        import('../src/prisma/prisma.module'),
        import('../src/telemetry/telemetry.module'),
        import('../src/config/env.schema'),
      ]);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
        PrismaModule,
        TelemetryModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const { configureBodyParser } = await import('../src/common/configure-body-parser');
    configureBodyParser(app);
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    // Same prefix `main.ts` sets — without it the route is `/telemetry/events`, not
    // `/v1/telemetry/events`, and every request below 404s before reaching the controller.
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  // F-7 (tester finding, 2026-08-20, repair attempt 3): the PREVIOUS version of this test
  // was pinned to a single depth (15_000), comfortably inside the ONE band the prior repair
  // happened to close. ADR 0010's Detection section says explicitly: "depth is not a stable
  // threshold... a test pinned to one depth proves little." No depth in 1500-9000 was ever
  // exercised — this sweeps that band and the values on either side of it, reproduced from
  // the tester's own fixture (`.artifacts/evidence/2/tester-human-repair/raw/t5-sweep.txt`).
  it('T5: a pathologically deep, Zod-legal metadata object never produces a 500 with zero per-event results, at any depth across the band that used to escape containment — the poisoned event is REJECTED, a good sibling still lands, HTTP 200 (tester findings F-1/F-3/F-6, 2026-08-20, repair attempt 3)', async () => {
    // Each request body is built as a JSON STRING by plain iteration, not `JSON.stringify`
    // on the deep object: `JSON.stringify` is itself a recursive walk, and so is
    // supertest/superagent's own request serializer (`fast-safe-stringify`) — both overflow
    // on this input for reasons that have nothing to do with the boundary this test is
    // actually proving. A regularly-shaped `{"child":...}` chain has a trivial closed-form
    // text representation, so building it by string repetition sidesteps recursion entirely
    // on the client side; the server still receives, and must still `JSON.parse`, a
    // genuinely deep structure.
    const depths = [200, 1000, 1500, 3000, 6000, 9000, 10000, 15000, 25000];

    for (const depth of depths) {
      const deepMetadataJson = '{"child":'.repeat(depth) + '{"leaf":true}' + '}'.repeat(depth);
      const goodEvent = {
        eventId: `http-t5-good-${depth}-start`,
        schemaVersion: '1',
        type: 'run.started',
        entityId: `http-t5-good-${depth}`,
        runId: `http-t5-good-${depth}`,
        occurredAt: '2026-08-19T10:00:00.000Z',
        payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
      };
      const bodyJson =
        `{"events":[${JSON.stringify(goodEvent)},` +
        `{"eventId":"http-t5-bad-${depth}-start","schemaVersion":"1","type":"run.started",` +
        `"entityId":"http-t5-bad-${depth}","runId":"http-t5-bad-${depth}","occurredAt":"2026-08-19T10:00:00.000Z",` +
        `"payload":{"workflowName":"wf","workflowVersion":"1.0.0","metadata":${deepMetadataJson}}}]}`;

      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .set('Content-Type', 'application/json')
        .send(bodyJson);
      const body = response.body as IngestResponse;

      expect(response.status, `depth ${depth}`).toBe(200);
      expect(body.results, `depth ${depth}`).toHaveLength(2);
      expect(body.results[0], `depth ${depth}`).toMatchObject({ status: 'ACCEPTED' });
      expect(body.results[1], `depth ${depth}`).toMatchObject({ status: 'REJECTED' });
      expect(body.results[1]?.error?.code, `depth ${depth}`).toBe('INVALID_PAYLOAD');
    }
  }, 120_000);

  it('T1: an unexpected, unclassified persistence failure returns a sanitized 500 body — no file path, no stack frame, no SQL code, no compiled source', async () => {
    // The depth-based fixture this test previously used (a ~3000-deep metadata object
    // overflowing structuredClone inside mergeEvent) is CLOSED by the F-1/F-3/F-6 fix:
    // that depth is now caught event-level, before the fold, and can never reach the
    // repository again — which is the point of that fix, and is what the T5 sweep above
    // proves. `classifyPersistenceFailure`'s 500-vs-503 split, and `AllExceptionsFilter`'s
    // sanitization of it, still need proving at the real HTTP boundary — sanitization is
    // status-driven (`status >= 500`, see `platform/api/src/common/all-exceptions.filter.ts`),
    // not code-specific, so nothing else in this suite drives an UNCLASSIFIED error through
    // the real controller/pipe/service/filter stack now that T4 only ever produces 503.
    // This stubs ONLY `TelemetryRepository.withEntityLock` for the duration of this one
    // test to throw a plain, non-Prisma error — routing, the real Zod pipe, the real
    // `TelemetryService` classification, and the real `AllExceptionsFilter` are untouched.
    const repository = app.get(TelemetryRepository);
    const spy = vi.spyOn(repository, 'withEntityLock').mockImplementation(() => {
      throw new Error('fake unclassified persistence failure — T1 HTTP boundary coverage');
    });

    try {
      const events = [
        {
          eventId: 'http-t1-bad-start',
          schemaVersion: '1',
          type: 'run.started',
          entityId: 'http-t1-bad',
          runId: 'http-t1-bad',
          occurredAt: '2026-08-19T10:00:00.000Z',
          payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
        },
      ];

      const response = await request(httpServer(app)).post('/v1/telemetry/events').send({ events });

      expect(response.status).toBe(500);
      // The ONLY shape AllExceptionsFilter ever sends for a 5xx: statusCode/error/message/
      // path/timestamp, message replaced with the generic string — never the exception itself.
      expect(response.body).toMatchObject({
        statusCode: 500,
        message: 'Internal server error',
      });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toMatch(/[A-Za-z]:\\\\/); // no Windows filesystem path
      expect(raw).not.toMatch(/at .*:\d+:\d+/); // no stack frame
      expect(raw).not.toMatch(/fake unclassified/); // never the stub's own message
      expect(raw).not.toMatch(/telemetry\.repository/);
      expect(raw).not.toMatch(/\b\d{5}\b/); // no bare 5-digit SQLSTATE-shaped code
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('T4: the database becoming unreachable mid-flight returns 503, not 200 — and the body is sanitized the same way', async () => {
    const prisma = app.get(PrismaService);
    // T4's own fixture: the table this service depends on disappears out from under it —
    // the database itself stays up and reachable (unlike a dropped connection), which is
    // exactly what made the pre-fix defect look like success: the wire response was 200.
    await prisma.client.$executeRawUnsafe('ALTER TABLE "Run" RENAME TO "Run_hidden_by_test";');

    try {
      const events = [
        {
          eventId: 'http-t4-start',
          schemaVersion: '1',
          type: 'run.started',
          entityId: 'http-t4-run',
          runId: 'http-t4-run',
          occurredAt: '2026-08-19T10:00:00.000Z',
          payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
        },
      ];

      const response = await request(httpServer(app)).post('/v1/telemetry/events').send({ events });

      expect(response.status).toBe(503);
      expect(response.status).not.toBe(200);
      expect(response.body).toMatchObject({ statusCode: 503, message: 'Internal server error' });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toMatch(/P2021/);
      expect(raw).not.toMatch(/does not exist/);
    } finally {
      await prisma.client.$executeRawUnsafe('ALTER TABLE "Run_hidden_by_test" RENAME TO "Run";');
    }
  }, 30_000);
});

/**
 * ADR 0014 / `p4.entity-ingest`. Detection block, verbatim: "integration tests that post
 * each of the five events through the real ingest endpoint and read the row back from
 * Postgres. Response-code assertions alone are not enough: the regression this replaces
 * (`type.startsWith('run.') ? 'run' : 'step'`) returned ACCEPTED with every gate green
 * while writing a Decision id into the Step table. Assert on the store."
 *
 * Real HTTP boundary, same shape as the ADR 0010 suite above: real Nest routing, the real
 * `TelemetryModule` (which now imports `DecisionsModule`/`ModelCallModule`/`ToolCallModule`/
 * `ErrorModule` — ADR 0014's "ONE NODE, NOT TWO"), the real `PrismaService`, real rows.
 */
describe('POST /v1/telemetry/events — the five Phase 4 entity types persist for real (ADR 0014)', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const httpServer = (a: INestApplication): Server => a.getHttpServer() as Server;

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

    const [{ ConfigModule }, { PrismaModule }, { TelemetryModule }, { validateEnv }] =
      await Promise.all([
        import('@nestjs/config'),
        import('../src/prisma/prisma.module'),
        import('../src/telemetry/telemetry.module'),
        import('../src/config/env.schema'),
      ]);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
        PrismaModule,
        TelemetryModule,
      ],
    }).compile();

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

  async function post(
    events: readonly unknown[],
  ): Promise<{ status: number; body: IngestResponse }> {
    const response = await request(httpServer(app)).post('/v1/telemetry/events').send({ events });
    return { status: response.status, body: response.body as IngestResponse };
  }

  it('decision.recorded writes a Decision row, and no Step or Run row', async () => {
    const response = await post([
      {
        eventId: 'evt-e2e-decision-1',
        schemaVersion: '2',
        type: 'decision.recorded',
        entityId: 'e2e-dec-1',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:00.000Z',
        payload: {
          stepId: 'e2e-step-1',
          decisionType: 'execution_strategy',
          contextKey: 'risk=low',
          availableOptions: ['sequential', 'parallel'],
          selectedOption: 'parallel',
        },
      },
    ]);

    expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const decision = await prisma.client.decision.findUnique({ where: { id: 'e2e-dec-1' } });
    expect(decision).not.toBeNull();
    expect(decision).toMatchObject({
      runId: 'e2e-run-1',
      stepId: 'e2e-step-1',
      decisionType: 'execution_strategy',
      selectedOption: 'parallel',
      outcome: 'UNKNOWN',
    });

    // The regression this test replaces: a Decision id written into the Step table.
    const step = await prisma.client.step.findUnique({ where: { id: 'e2e-dec-1' } });
    expect(step).toBeNull();
    const run = await prisma.client.run.findUnique({ where: { id: 'e2e-dec-1' } });
    expect(run).toBeNull();
  });

  it('decision.outcome_attested updates the original Decision row, never inserting a second one', async () => {
    await post([
      {
        eventId: 'evt-e2e-decision-2',
        schemaVersion: '2',
        type: 'decision.recorded',
        entityId: 'e2e-dec-2',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:01.000Z',
        payload: {
          stepId: 'e2e-step-1',
          decisionType: 'execution_strategy',
          availableOptions: ['a', 'b'],
          selectedOption: 'a',
        },
      },
    ]);

    // DoD line 4: "An attestation posted from a second process updates the original
    // Decision." Modelled as a second, independent ingest call.
    const attestResponse = await post([
      {
        eventId: 'evt-e2e-attest-2',
        schemaVersion: '2',
        type: 'decision.outcome_attested',
        entityId: 'e2e-dec-2',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:02.000Z',
        payload: { outcome: 'SUCCESS' },
      },
    ]);

    expect(attestResponse.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const rows = await prisma.client.decision.findMany({ where: { id: 'e2e-dec-2' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      selectedOption: 'a', // the recording side survives the later attestation
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
    });
  });

  it('DoD line 5: an attestation for a decisionId the platform has never recorded is accepted and stored', async () => {
    const response = await post([
      {
        eventId: 'evt-e2e-attest-cold',
        schemaVersion: '2',
        type: 'decision.outcome_attested',
        entityId: 'e2e-dec-never-recorded',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:03.000Z',
        payload: { outcome: 'FAILURE' },
      },
    ]);

    expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const decision = await prisma.client.decision.findUnique({
      where: { id: 'e2e-dec-never-recorded' },
    });
    expect(decision).toMatchObject({
      runId: 'e2e-run-1',
      stepId: null,
      decisionType: null,
      outcome: 'FAILURE',
      outcomeAttestedBy: 'CALLER',
    });
  });

  it('model_call.recorded writes a ModelCall row, and no Step or Run row', async () => {
    const response = await post([
      {
        eventId: 'evt-e2e-model-1',
        schemaVersion: '2',
        type: 'model_call.recorded',
        entityId: 'e2e-mc-1',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:04.000Z',
        payload: {
          stepId: 'e2e-step-1',
          provider: 'anthropic',
          model: 'claude-opus-5',
          latencyMs: 812,
          inputTokens: 1200,
          outputTokens: 340,
          status: 'ok',
        },
      },
    ]);

    expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const modelCall = await prisma.client.modelCall.findUnique({ where: { id: 'e2e-mc-1' } });
    expect(modelCall).toMatchObject({
      runId: 'e2e-run-1',
      stepId: 'e2e-step-1',
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 340,
    });
    expect(await prisma.client.step.findUnique({ where: { id: 'e2e-mc-1' } })).toBeNull();
    expect(await prisma.client.run.findUnique({ where: { id: 'e2e-mc-1' } })).toBeNull();
  });

  it('tool_call.recorded writes a ToolCall row, and no Step or Run row', async () => {
    const response = await post([
      {
        eventId: 'evt-e2e-tool-1',
        schemaVersion: '2',
        type: 'tool_call.recorded',
        entityId: 'e2e-tc-1',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:05.000Z',
        payload: {
          stepId: 'e2e-step-1',
          toolName: 'search',
          input: { query: 'weather' },
          output: { rows: 3 },
          inputTruncated: false,
          outputTruncated: false,
          inputBytes: 42,
          outputBytes: 100,
          startedAt: '2026-09-02T10:00:05.000Z',
          completedAt: '2026-09-02T10:00:05.250Z',
          durationMs: 250,
          success: true,
        },
      },
    ]);

    expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const toolCall = await prisma.client.toolCall.findUnique({ where: { id: 'e2e-tc-1' } });
    expect(toolCall).toMatchObject({
      runId: 'e2e-run-1',
      stepId: 'e2e-step-1',
      toolName: 'search',
      input: { query: 'weather' },
      output: { rows: 3 },
      success: true,
    });
    expect(await prisma.client.step.findUnique({ where: { id: 'e2e-tc-1' } })).toBeNull();
    expect(await prisma.client.run.findUnique({ where: { id: 'e2e-tc-1' } })).toBeNull();
  });

  it('error.recorded writes an Error row, and no Step or Run row', async () => {
    const response = await post([
      {
        eventId: 'evt-e2e-error-1',
        schemaVersion: '2',
        type: 'error.recorded',
        entityId: 'e2e-err-1',
        runId: 'e2e-run-1',
        occurredAt: '2026-09-02T10:00:06.000Z',
        payload: { stepId: 'e2e-step-1', type: 'TimeoutError', message: 'timed out after 30s' },
      },
    ]);

    expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const error = await prisma.client.error.findUnique({ where: { id: 'e2e-err-1' } });
    expect(error).toMatchObject({
      runId: 'e2e-run-1',
      stepId: 'e2e-step-1',
      type: 'TimeoutError',
      message: 'timed out after 30s',
    });
    expect(await prisma.client.step.findUnique({ where: { id: 'e2e-err-1' } })).toBeNull();
    expect(await prisma.client.run.findUnique({ where: { id: 'e2e-err-1' } })).toBeNull();
  });

  it('ADR 0014 decision 2: droppedSinceLastBatch folds into the named run’s droppedTelemetryEventCount', async () => {
    const runId = 'e2e-run-dropped';

    await post([
      {
        eventId: 'evt-e2e-run-dropped-start',
        schemaVersion: '1',
        type: 'run.started',
        entityId: runId,
        runId,
        occurredAt: '2026-09-02T10:00:07.000Z',
        payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
      },
    ]);

    let run = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(run?.droppedTelemetryEventCount).toBeNull();

    await request(httpServer(app))
      .post('/v1/telemetry/events')
      .send({
        events: [
          {
            eventId: 'evt-e2e-run-dropped-complete',
            schemaVersion: '1',
            type: 'run.completed',
            entityId: runId,
            runId,
            occurredAt: '2026-09-02T10:00:08.000Z',
            payload: { status: 'COMPLETED' },
          },
        ],
        droppedSinceLastBatch: 3,
      });

    run = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(run?.droppedTelemetryEventCount).toBe(3);
  });

  /**
   * S1 (Reviewer finding, ASYNC-5 [MUST], Phase 4 phase gate repair attempt 1).
   * `IngestRequestSchema.deliveryId` and its use inside `TelemetryRepository.
   * incrementDroppedCount` exist to close exactly this: the SDK's `deliverBatch` retries the
   * SAME `droppedSinceLastBatch` snapshot — with the SAME `deliveryId` — on any `retryable`
   * outcome, including a `200` the client never saw because its own read timed out AFTER the
   * server had already committed. Without a replay key the second, identical POST below
   * would double-credit the run; this proves it does not, against real Postgres (the unique
   * constraint the fix relies on cannot be proven against a mock).
   *
   * Mutation check (quoted verbatim in the Builder handoff): reverting
   * `TelemetryRepository.incrementDroppedCount` to the pre-fix plain
   * `$executeRaw` COALESCE/+= call (no `deliveryId` branch) turns this test red — the run
   * ends up credited `10`, not `5` — and restoring the fix turns it green again.
   */
  it('S1: replaying the identical batch (same events, same deliveryId) credits droppedSinceLastBatch once, not twice', async () => {
    const runId = 'e2e-run-dropped-replay';

    await post([
      {
        eventId: 'evt-e2e-run-dropped-replay-start',
        schemaVersion: '1',
        type: 'run.started',
        entityId: runId,
        runId,
        occurredAt: '2026-09-02T10:00:11.000Z',
        payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
      },
    ]);

    const body = {
      events: [
        {
          eventId: 'evt-e2e-run-dropped-replay-complete',
          schemaVersion: '1',
          type: 'run.completed',
          entityId: runId,
          runId,
          occurredAt: '2026-09-02T10:00:12.000Z',
          payload: { status: 'COMPLETED' },
        },
      ],
      droppedSinceLastBatch: 5,
      deliveryId: 'e2e-replay-key-1',
    };

    // Attempt 1: the request that "committed", whose 200 the client (hypothetically) never
    // saw — modelled here simply by not inspecting its response and posting again.
    await request(httpServer(app)).post('/v1/telemetry/events').send(body);

    // Attempt 2: the SDK's retry of the identical snapshot — same events (including the same
    // eventId, so the event itself is correctly DUPLICATE), same droppedSinceLastBatch, same
    // deliveryId.
    const replay = await request(httpServer(app)).post('/v1/telemetry/events').send(body);
    const replayBody = replay.body as IngestResponse;

    expect(replayBody.results[0]).toMatchObject({ status: 'DUPLICATE' });

    const run = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(run?.droppedTelemetryEventCount).toBe(5);
    expect(run?.droppedTelemetryEventCount).not.toBe(10);
  });

  describe('F1 / B1 / F4 / B5 (Phase 4 phase gate repair attempt 2): the drop replay key lives in its own table, not IngestedEvent', () => {
    const runStarted = (
      runId: string,
      eventId: string,
      occurredAt: string,
    ): Record<string, unknown> => ({
      eventId,
      schemaVersion: '1',
      type: 'run.started',
      entityId: runId,
      runId,
      occurredAt,
      payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    });

    /**
     * F1 (Tester) / B1 (Reviewer). Attempt 1 wrote the replay key as `"drop:" + deliveryId`
     * into `IngestedEvent.eventId` (`VarChar(128)`) — the 5-character prefix meant any
     * legal, `IdSchema`-valid `deliveryId` of 124-128 chars produced a 129-133 char key and
     * a Postgres `22001`, raised AFTER the batch's own event had already committed, and
     * identical on every retry. `DropDelivery.deliveryId` has no prefix, so the same value
     * that used to 500 at 124 chars must now succeed even at the wire's own maximum, 128 —
     * proved at the boundary, not by inspection of the column width.
     */
    it('F1: a deliveryId at the wire maximum (128 chars) does not overflow the replay ledger', async () => {
      const runId = 'e2e-run-dropped-delivery-id-max';
      const deliveryId = 'd'.repeat(128);
      expect(deliveryId).toHaveLength(128);

      await post([runStarted(runId, 'evt-e2e-delivery-id-max-start', '2026-09-03T10:00:00.000Z')]);

      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [
            runStarted(runId, 'evt-e2e-delivery-id-max-complete', '2026-09-03T10:00:01.000Z'),
          ],
          droppedSinceLastBatch: 4,
          deliveryId,
        });

      expect(response.status).toBe(200);
      expect(response.status).not.toBe(500);

      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(4);

      // And the identical retry — the whole point of a replay-stable key — still credits
      // once, at this same boundary length.
      const retry = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [
            runStarted(runId, 'evt-e2e-delivery-id-max-complete', '2026-09-03T10:00:01.000Z'),
          ],
          droppedSinceLastBatch: 4,
          deliveryId,
        });
      expect(retry.status).toBe(200);

      const runAfterRetry = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(runAfterRetry?.droppedTelemetryEventCount).toBe(4);
      expect(runAfterRetry?.droppedTelemetryEventCount).not.toBe(8);
    });

    /**
     * F4 (Tester) / part of B1's fix. Attempt 1's replay key shared `IngestedEvent.eventId`'s
     * value space with real, caller-supplied event ids on a public wire: a real event whose
     * `eventId` happened to equal `"drop:" + X` collided with a drop batch whose `deliveryId`
     * was `X`. Direction A here: seed a drop report under `deliveryId`, then send a REAL
     * event whose `eventId` is the exact string `"drop:" + deliveryId` — it must be accepted
     * as a new event, not silently read as `DUPLICATE` against the ledger row the drop report
     * left behind.
     */
    it('F4 direction A: a real eventId shaped like the old "drop:" + deliveryId key is accepted, not swallowed as DUPLICATE', async () => {
      const runId = 'e2e-run-drop-namespace-a';
      const deliveryId = 'e2e-namespace-a-delivery';

      await post([runStarted(runId, 'evt-e2e-namespace-a-start', '2026-09-03T10:00:02.000Z')]);

      await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runStarted(runId, 'evt-e2e-namespace-a-drop-batch', '2026-09-03T10:00:03.000Z')],
          droppedSinceLastBatch: 2,
          deliveryId,
        });

      const collidingEventId = `drop:${deliveryId}`;
      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [
            {
              eventId: collidingEventId,
              schemaVersion: '1',
              type: 'step.started',
              entityId: 'e2e-namespace-a-step',
              runId,
              occurredAt: '2026-09-03T10:00:04.000Z',
              payload: { name: 's', agentName: 'a', type: 'execute', parentStepId: null },
            },
          ],
        });
      const body = response.body as IngestResponse;

      expect(body.results[0]).toMatchObject({ eventId: collidingEventId, status: 'ACCEPTED' });
      const step = await prisma.client.step.findUnique({ where: { id: 'e2e-namespace-a-step' } });
      expect(step).not.toBeNull();
    });

    /**
     * F4 direction B. A real, accepted event whose `eventId` is `"drop:" + Y` must not make a
     * later drop report with `deliveryId: Y` silently discarded — before this fix, the report
     * lost the ledger insert race against that pre-existing `eventId` and the run's count
     * stayed `NULL` despite a 200 response.
     */
    it('F4 direction B: a drop report is credited even when a real event already used "drop:" + deliveryId as its own eventId', async () => {
      const runId = 'e2e-run-drop-namespace-b';
      const deliveryId = 'e2e-namespace-b-delivery';
      const collidingEventId = `drop:${deliveryId}`;

      await post([
        runStarted(runId, 'evt-e2e-namespace-b-start', '2026-09-03T10:00:05.000Z'),
        {
          eventId: collidingEventId,
          schemaVersion: '1',
          type: 'step.started',
          entityId: 'e2e-namespace-b-step',
          runId,
          occurredAt: '2026-09-03T10:00:06.000Z',
          payload: { name: 's', agentName: 'a', type: 'execute', parentStepId: null },
        },
      ]);

      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runStarted(runId, 'evt-e2e-namespace-b-drop-batch', '2026-09-03T10:00:07.000Z')],
          droppedSinceLastBatch: 42,
          deliveryId,
        });

      expect(response.status).toBe(200);
      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(42);
      expect(run?.droppedTelemetryEventCount).not.toBeNull();
    });

    /**
     * B5. `IngestedEvent` is documented, in two places, as holding real accepted events and
     * nothing else. Proves it by construction rather than by re-reading the comments: a run
     * that received one real event and one drop report has exactly one `IngestedEvent` row
     * (the real event) and its drop replay key lives in `DropDelivery` instead.
     */
    it('B5: a drop report never adds a row to IngestedEvent — it lands in DropDelivery', async () => {
      const runId = 'e2e-run-drop-ledger-split';
      const deliveryId = 'e2e-ledger-split-delivery';

      await post([runStarted(runId, 'evt-e2e-ledger-split-start', '2026-09-03T10:00:08.000Z')]);

      await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runStarted(runId, 'evt-e2e-ledger-split-complete', '2026-09-03T10:00:09.000Z')],
          droppedSinceLastBatch: 6,
          deliveryId,
        });

      expect(await prisma.client.ingestedEvent.count({ where: { runId } })).toBe(2);
      expect(
        await prisma.client.ingestedEvent.findFirst({
          where: { runId, eventId: { contains: 'drop:' } },
        }),
      ).toBeNull();
      expect(
        await prisma.client.dropDelivery.findUnique({
          where: { runId_deliveryId: { runId, deliveryId } },
        }),
      ).not.toBeNull();
    });

    /**
     * F5 (Tester). A zero-amount report needs no replay guard — adding zero is idempotent on
     * every retry and every flush — so `incrementDroppedCount` skips `DropDelivery`
     * entirely for `amount === 0`, even though every batch the SDK sends carries the field.
     * Five flushes reporting zero must leave zero rows, not one per flush.
     */
    it('F5: a batch reporting zero drops never grows DropDelivery, across many flushes', async () => {
      const runId = 'e2e-run-drop-zero-no-growth';

      await post([runStarted(runId, 'evt-e2e-zero-growth-start', '2026-09-03T10:00:10.000Z')]);

      for (let i = 0; i < 5; i += 1) {
        const response = await request(httpServer(app))
          .post('/v1/telemetry/events')
          .send({
            events: [
              runStarted(runId, `evt-e2e-zero-growth-${i}`, `2026-09-03T10:00:${11 + i}.000Z`),
            ],
            droppedSinceLastBatch: 0,
            deliveryId: `e2e-zero-growth-delivery-${i}`,
          });
        expect(response.status).toBe(200);
      }

      expect(await prisma.client.dropDelivery.count({ where: { runId } })).toBe(0);
      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(0);
      expect(run?.droppedTelemetryEventCount).not.toBeNull();
    });
  });

  /**
   * R3 (Reviewer finding, 2026-09-02, repair attempt 1). The test above claims "a real zero
   * included" in its title but only ever posted `droppedSinceLastBatch: 3`; the zero case is
   * the one ADR 0014's Detection section actually asks for at the store level, because zero
   * is the value the column has to be able to tell apart from "never reported" — and NULL vs
   * 0 is exactly the distinction `Run.droppedTelemetryEventCount` refuses `@default(0)` to
   * preserve. Given its own run, so the two claims fail independently.
   */
  it('ADR 0014 decision 2: a reported droppedSinceLastBatch of 0 stores 0, distinguishable from a never-reported null', async () => {
    const runId = 'e2e-run-dropped-zero';

    await post([
      {
        eventId: 'evt-e2e-run-dropped-zero-start',
        schemaVersion: '1',
        type: 'run.started',
        entityId: runId,
        runId,
        occurredAt: '2026-09-02T10:00:09.000Z',
        payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
      },
    ]);

    // Never reported: NULL, not 0. This is the value the zero below has to be distinguishable
    // from — asserted here so the two are compared against each other, not merely each
    // against a literal.
    const beforeReport = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(beforeReport?.droppedTelemetryEventCount).toBeNull();

    await request(httpServer(app))
      .post('/v1/telemetry/events')
      .send({
        events: [
          {
            eventId: 'evt-e2e-run-dropped-zero-complete',
            schemaVersion: '1',
            type: 'run.completed',
            entityId: runId,
            runId,
            occurredAt: '2026-09-02T10:00:10.000Z',
            payload: { status: 'COMPLETED' },
          },
        ],
        droppedSinceLastBatch: 0,
      });

    const afterReport = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(afterReport?.droppedTelemetryEventCount).toBe(0);
    expect(afterReport?.droppedTelemetryEventCount).not.toBeNull();
    expect(afterReport?.droppedTelemetryEventCount).not.toBe(
      beforeReport?.droppedTelemetryEventCount,
    );
  });

  /**
   * R4 (Builder finding raised in repair attempt 1's handoff; decision settled by the
   * Coordinator for repair attempt 2). Two halves of one guarantee — `Run.
   * droppedTelemetryEventCount` can never raise SQLSTATE 22003 — proved here against the
   * same real Postgres, because neither half is provable against a fake.
   *
   * Half one is the request-level bound in `IngestRequestSchema`, which stops one BATCH from
   * carrying an unstorable value. Half two is `incrementDroppedCount`'s saturating add,
   * which is the only thing standing between the RUNNING TOTAL and the same overflow: the
   * statement is `COALESCE(col, 0) + amount` across every batch for the life of a run, so
   * bounding each batch bounds each addend and nothing else. A bound alone would have moved
   * the failure from one batch to two.
   *
   * `POSTGRES_INT4_MAX + 1` and the ceiling itself are Postgres's own numbers, not constants
   * read back out of the code under test.
   */
  describe('R4: the drop counter cannot overflow its int4 column, per batch or in total', () => {
    const POSTGRES_INT4_MAX = 2_147_483_647;

    const runEvent = (
      runId: string,
      eventId: string,
      occurredAt: string,
    ): Record<string, unknown> => ({
      eventId,
      schemaVersion: '1',
      type: 'run.started',
      entityId: runId,
      runId,
      occurredAt,
      payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    });

    it('refuses a batch reporting more drops than int4 can hold, with HTTP 400 and no write at all', async () => {
      const runId = 'e2e-run-dropped-overflow';

      await post([runEvent(runId, 'evt-e2e-dropped-overflow-start', '2026-09-02T10:00:11.000Z')]);

      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runEvent(runId, 'evt-e2e-dropped-overflow-2', '2026-09-02T10:00:12.000Z')],
          droppedSinceLastBatch: POSTGRES_INT4_MAX + 1,
        });

      expect(response.status).toBe(400);
      // The failure this replaces was a 500 raised AFTER the batch's events had committed.
      expect(response.status).not.toBe(500);

      // Request-level means the whole batch is refused: the counter is still "never
      // reported", and the second event never landed either.
      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBeNull();
      expect(
        await prisma.client.ingestedEvent.findUnique({
          where: { runId_eventId: { runId, eventId: 'evt-e2e-dropped-overflow-2' } },
        }),
      ).toBeNull();
    });

    it('stores a batch reporting exactly the int4 ceiling', async () => {
      const runId = 'e2e-run-dropped-ceiling';

      await post([runEvent(runId, 'evt-e2e-dropped-ceiling-start', '2026-09-02T10:00:13.000Z')]);

      const response = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runEvent(runId, 'evt-e2e-dropped-ceiling-2', '2026-09-02T10:00:14.000Z')],
          droppedSinceLastBatch: POSTGRES_INT4_MAX,
        });

      expect(response.status).toBe(200);
      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(POSTGRES_INT4_MAX);
    });

    it('saturates the RUNNING TOTAL at the ceiling instead of overflowing it on the next batch', async () => {
      const runId = 'e2e-run-dropped-saturate';

      await post([runEvent(runId, 'evt-e2e-dropped-saturate-start', '2026-09-02T10:00:15.000Z')]);

      // Batch one takes the column to its exact ceiling — every value here is individually
      // legal, so the bound in `IngestRequestSchema` has nothing to say about batch two.
      const first = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runEvent(runId, 'evt-e2e-dropped-saturate-2', '2026-09-02T10:00:16.000Z')],
          droppedSinceLastBatch: POSTGRES_INT4_MAX,
        });
      expect(first.status).toBe(200);

      // Batch two adds one more. `COALESCE(col, 0) + 1` is 2^31, which int4 cannot hold: this
      // is the request that used to raise 22003 out of `incrementDroppedCount` — after its
      // own event had already committed, so the run was poisoned for every batch that
      // followed it.
      const second = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runEvent(runId, 'evt-e2e-dropped-saturate-3', '2026-09-02T10:00:17.000Z')],
          droppedSinceLastBatch: 1,
        });

      expect(second.status).toBe(200);
      expect(second.status).not.toBe(500);

      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(POSTGRES_INT4_MAX);

      // And the run is not poisoned: a third batch still succeeds and still ingests events.
      const third = await request(httpServer(app))
        .post('/v1/telemetry/events')
        .send({
          events: [runEvent(runId, 'evt-e2e-dropped-saturate-4', '2026-09-02T10:00:18.000Z')],
          droppedSinceLastBatch: 7,
        });
      expect(third.status).toBe(200);
      expect(
        await prisma.client.ingestedEvent.findUnique({
          where: { runId_eventId: { runId, eventId: 'evt-e2e-dropped-saturate-4' } },
        }),
      ).not.toBeNull();
    });

    // The control. Saturation must not round ordinary arithmetic — a normal two-batch total
    // is still the exact sum, not a clamped one.
    it('still adds normal batches exactly, with no clamping anywhere near the ceiling', async () => {
      const runId = 'e2e-run-dropped-exact-sum';

      await post([runEvent(runId, 'evt-e2e-dropped-sum-start', '2026-09-02T10:00:19.000Z')]);

      for (const [i, amount] of [3, 4].entries()) {
        const response = await request(httpServer(app))
          .post('/v1/telemetry/events')
          .send({
            events: [runEvent(runId, `evt-e2e-dropped-sum-${i}`, '2026-09-02T10:00:20.000Z')],
            droppedSinceLastBatch: amount,
          });
        expect(response.status).toBe(200);
      }

      const run = await prisma.client.run.findUnique({ where: { id: runId } });
      expect(run?.droppedTelemetryEventCount).toBe(7);
    });
  });

  /**
   * R1 (Reviewer finding, 2026-09-02, repair attempt 1). Confirmed against this same image
   * before the fix — `.artifacts/evidence/4/p4.entity-ingest/coordinator/s1-confirmation.md`,
   * raw error `22008 date/time field value out of range: "0000-01-01 00:00:00"` thrown from
   * `ToolCallRepository.record` out through `TelemetryService.ingest`, HTTP 500, zero
   * per-event results, and the identical batch throwing again on every retry because the Run
   * event beside it had already committed.
   *
   * These fixtures are the confirmation probe's, adapted to this suite's HTTP boundary: the
   * tool-call payload is the same one the passing test above uses, with ONE field varied at a
   * time and `occurredAt` left valid throughout — so the only thing that can produce a
   * rejection is the new payload screen, not the pre-existing `occurredAt` one.
   */
  describe('R1: a payload value Postgres cannot store rejects only its own event', () => {
    const toolCall = (
      id: string,
      payload: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      eventId: `${id}-evt`,
      schemaVersion: '2',
      type: 'tool_call.recorded',
      entityId: id,
      runId: 'e2e-r1-run',
      occurredAt: '2026-09-02T10:00:05.000Z',
      payload: {
        stepId: 'e2e-step-1',
        toolName: 'search',
        input: { query: 'weather' },
        output: { rows: 3 },
        inputTruncated: false,
        outputTruncated: false,
        inputBytes: 42,
        outputBytes: 100,
        startedAt: '2026-09-02T10:00:05.000Z',
        completedAt: '2026-09-02T10:00:05.250Z',
        durationMs: 250,
        success: true,
        ...payload,
      },
    });

    it('a year-0000 startedAt is a per-event REJECTED, not a thrown 500', async () => {
      const response = await post([
        toolCall('r1-tc-started', { startedAt: '0000-01-01T00:00:00.000Z' }),
      ]);

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ status: 'REJECTED' });
      expect(response.body.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
      expect(response.body.results[0]?.error?.message).toContain('startedAt');
      expect(response.body.rejected).toBe(1);
      // The row Postgres would have refused was never attempted.
      expect(
        await prisma.client.toolCall.findUnique({ where: { id: 'r1-tc-started' } }),
      ).toBeNull();
    });

    it('a year-0000 observedAt on decision.outcome_attested is a per-event REJECTED too', async () => {
      const response = await post([
        {
          eventId: 'r1-att-evt',
          schemaVersion: '2',
          type: 'decision.outcome_attested',
          entityId: 'r1-dec',
          runId: 'e2e-r1-run',
          occurredAt: '2026-09-02T10:00:05.000Z',
          payload: { outcome: 'SUCCESS', observedAt: '0000-01-01T00:00:00.000Z' },
        },
      ]);

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ status: 'REJECTED' });
      expect(response.body.results[0]?.error?.message).toContain('observedAt');
      // §14 accepts an attestation for an unknown decision id by INSERTING a row — so the
      // absence of one here is the evidence the rejection happened before persistence.
      expect(await prisma.client.decision.findUnique({ where: { id: 'r1-dec' } })).toBeNull();
    });

    it('an int4-overflowing durationMs is a per-event REJECTED (SQLSTATE 22003, same seam)', async () => {
      const response = await post([toolCall('r1-tc-duration', { durationMs: 2_147_483_648 })]);

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ status: 'REJECTED' });
      expect(response.body.results[0]?.error?.message).toContain('durationMs');
      expect(
        await prisma.client.toolCall.findUnique({ where: { id: 'r1-tc-duration' } }),
      ).toBeNull();
    });

    /**
     * The assertion the whole repair exists for. Before the fix this exact batch produced
     * HTTP 500 with no `results` array at all, the `run.started` row committed anyway, and
     * every retry of the identical batch threw again — the batch could never succeed. The
     * retry below is the part that proves the poison is gone rather than merely deferred.
     */
    it('well-formed siblings in the SAME batch still land, and the batch is retryable', async () => {
      const batch = [
        {
          eventId: 'r1-run-start',
          schemaVersion: '1',
          type: 'run.started',
          entityId: 'e2e-r1-run',
          runId: 'e2e-r1-run',
          occurredAt: '2026-09-02T10:00:04.000Z',
          payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
        },
        toolCall('r1-tc-poison', { startedAt: '0000-01-01T00:00:00.000Z' }),
        toolCall('r1-tc-good'),
      ];

      const response = await post(batch);

      expect(response.status).toBe(200);
      expect(response.body.results.map((r) => r.status)).toStrictEqual([
        'ACCEPTED',
        'REJECTED',
        'ACCEPTED',
      ]);
      expect(await prisma.client.run.findUnique({ where: { id: 'e2e-r1-run' } })).not.toBeNull();
      expect(
        await prisma.client.toolCall.findUnique({ where: { id: 'r1-tc-good' } }),
      ).not.toBeNull();
      expect(await prisma.client.toolCall.findUnique({ where: { id: 'r1-tc-poison' } })).toBeNull();

      // Retrying the identical batch now produces an honest per-event answer instead of a
      // second 500. Previously this threw, twice, and could never do anything else.
      //
      // The Run event comes back DUPLICATE off the `IngestedEvent` ledger; the tool call
      // deliberately is NOT asserted to, because the entity-write path does not consult that
      // ledger at all — a separate, non-blocking finding filed to `BACKLOG.md`, and one this
      // test must not quietly pin as correct. What it does assert is the property this repair
      // owns: neither good event is REJECTED, and the poison event still rejects only itself.
      const retry = await post(batch);
      expect(retry.status).toBe(200);
      expect(retry.body.results[0]?.status).toBe('DUPLICATE');
      expect(retry.body.results[1]).toMatchObject({ status: 'REJECTED' });
      expect(retry.body.results[2]?.status).not.toBe('REJECTED');
    });

    it('CONTROL: representable values at the very edge of both bounds still persist', async () => {
      const response = await post([
        toolCall('r1-tc-edge', {
          startedAt: '0001-01-01T00:00:00.000Z',
          durationMs: 2_147_483_647,
          inputBytes: 2_147_483_647,
        }),
      ]);

      expect(response.body.results[0]).toMatchObject({ status: 'ACCEPTED' });
      const stored = await prisma.client.toolCall.findUnique({ where: { id: 'r1-tc-edge' } });
      expect(stored).toMatchObject({ durationMs: 2_147_483_647, inputBytes: 2_147_483_647 });
      expect(stored?.startedAt.toISOString()).toBe('0001-01-01T00:00:00.000Z');
    });
  });
});
