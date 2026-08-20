import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryRepository } from '../src/telemetry/telemetry.repository';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import type { Env } from '../src/config/env.schema';

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
 * became a per-key/per-event winner is misclassified ACCEPTED) is NOT covered by fixes in
 * this file. It is deferred to `p2.idempotency` by human ruling
 * (`.artifacts/evidence/2/f3-ruling.md`); the "KNOWN GAP" test below documents it without
 * claiming it closed.
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
  const service = new TelemetryService(repository);
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

  describe('D2: a failing entity group is contained to that group', () => {
    it('a Postgres-level failure (occurredAt year 0000, SQLSTATE 22008) on one entity does not discard the rest of the batch, and returns a per-event result for every event', async () => {
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

        // Every event gets a result — the batch is never lost because one group's
        // transaction failed.
        expect(response.results).toHaveLength(3);
        expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[1]?.error?.code).toBe('PROCESSING_FAILED');
        expect(response.results[2]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.accepted).toBe(2);
        expect(response.rejected).toBe(1);

        // The good groups actually persisted — including the one AFTER the failing group,
        // proving a mid-batch failure does not abort groups still to come.
        expect((await repository.loadRun('d2-good-before'))?.startedAt).not.toBeNull();
        expect((await repository.loadRun('d2-good-after'))?.startedAt).not.toBeNull();
        // The failing group's own transaction rolled back — nothing landed for it.
        expect(await repository.loadRun('d2-bad-year-zero')).toBeUndefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('a failure INSIDE the fold itself (RangeError: structuredClone overflows on a ~3000-deep metadata object, before any Postgres call) is contained the same way', async () => {
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        // Zod-legal: MetadataSchema is z.record(z.string(), z.unknown()) and never recurses
        // into the value's own shape, so this passes parseTelemetryEvent AND
        // containsUnsafeUnicode (both proven, by direct probe, not to overflow at this
        // depth) — the RangeError is exclusive to structuredClone inside mergeEvent.
        let deeplyNested: unknown = { v: 1 };
        for (let i = 0; i < 3000; i++) {
          deeplyNested = { child: deeplyNested };
        }

        const response = await service.ingest([
          runStartedEvent('d2-good-sibling'),
          runStartedEvent('d2-bad-deep-metadata', {
            eventId: 'd2-bad-deep-metadata-start',
            payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: deeplyNested },
          }),
        ]);

        expect(response.results).toHaveLength(2);
        expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
        expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
        expect(response.results[1]?.error?.code).toBe('PROCESSING_FAILED');
        expect(response.rejected).toBe(1);

        expect((await repository.loadRun('d2-good-sibling'))?.startedAt).not.toBeNull();
        expect(await repository.loadRun('d2-bad-deep-metadata')).toBeUndefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('F3 in the tester-reverify sense (§12 dedup ledger gap): deferred to p2.idempotency, not this lane', () => {
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

    it('KNOWN GAP (documented, not a regression): reposting a start eventId that LOST the tie-break across two requests is misclassified ACCEPTED again, not DUPLICATE', async () => {
      // This documents the gap `telemetry.service.ts`'s `collectKnownEventIds` doc comment
      // now honestly describes: only the WINNING start event's id survives across requests
      // (`startEventId`, one column). Closing it for real needs a persisted per-start-event
      // ledger schema.prisma does not have — out of `platform/api/src/**`'s reach. Fail-safe
      // either way: no second row, no error, the state resolves identically regardless. This
      // is the same class of gap the tester's F3 covers at the entity level (dedup ledger,
      // `.artifacts/evidence/2/f3-ruling.md`), deferred to `p2.idempotency` by human ruling —
      // this test documents it, it does not close it.
      const { service, repository, prisma } = await newTrio(connectionString);
      try {
        const entityId = 'dedup-loser-run';

        // First request: two start events for a never-before-seen entity. The earlier
        // occurredAt (evt-early) wins startEventId; evt-late loses and leaves no ledger
        // trace of its own.
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

        // Second, separate request: repost the LOSING event from the first request.
        const second = await service.ingest([
          runStartedEvent(entityId, {
            eventId: 'evt-late',
            occurredAt: '2026-08-19T10:00:00.000Z',
          }),
        ]);

        // Documents the gap: this SHOULD be DUPLICATE per §12, and today is not.
        expect(second.results[0]).toMatchObject({ status: 'ACCEPTED' });

        // Fail-safe: no new row, state unchanged (still evt-early's fields as the winner).
        const after = await repository.loadRun(entityId);
        expect(after?.startEventId).toBe('evt-early');
        expect(after?.startedAt).toBe(before?.startedAt);
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);
  });
});
