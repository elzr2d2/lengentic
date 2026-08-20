import { describe, expect, it, vi } from 'vitest';
import { TelemetryRepository } from './telemetry.repository';
import type { EntityMergeState } from './merge-rules';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The seam under test: how `EntityMergeState` (merge-rules.ts's domain type) maps onto the
 * Run/Step columns schema.prisma actually has — in particular the single shared `metadata`
 * column standing in for two logically separate slots (start-side vs completion-side
 * metadata), and `receivedAt` being create-only. The real Prisma client is not exercised
 * here (that round trip against a live schema belongs to `test/*.integration.spec.ts`, not
 * `pnpm test`) — only what THIS repository sends it and reads back from it.
 */
/**
 * The one shape every test in this file actually inspects from an `upsert` call — not the
 * full Prisma-generated input type (which would need the boundary this file, and
 * `telemetry.repository.ts`, deliberately does not cross — CLAUDE.md ## Types). Typing the
 * mock this way, instead of leaving `vi.fn()` untyped, is what turns `.mock.calls[0][0]`
 * from `any` into a real type at every call site below.
 */
interface UpsertCallArgs {
  readonly where: { readonly id: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakePrismaService(): {
  prisma: PrismaService;
  run: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn<(args: UpsertCallArgs) => Promise<void>>>;
  };
  step: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn<(args: UpsertCallArgs) => Promise<void>>>;
  };
} {
  const run = {
    findUnique: vi.fn(),
    upsert: vi.fn<(args: UpsertCallArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const step = {
    findUnique: vi.fn(),
    upsert: vi.fn<(args: UpsertCallArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const prisma = { client: { run, step } } as unknown as PrismaService;
  return { prisma, run, step };
}

/** The one shape the run-liveness tests inspect from a `run.updateMany` call. */
interface RunUpdateManyArgs {
  readonly where: {
    readonly id: string;
    readonly lastEventAt?: { readonly lt: Date };
  };
  readonly data: { readonly lastEventAt: Date };
}

interface IngestedEventFindManyArgs {
  readonly where: { readonly runId: string; readonly eventId: { readonly in: string[] } };
  readonly select: { readonly eventId: true };
}

interface IngestedEventCreateManyArgs {
  readonly data: ReadonlyArray<{ eventId: string; runId: string; receivedAt: Date }>;
  readonly skipDuplicates: true;
}

/**
 * `withEntityLock`'s own seam: `$transaction` here just invokes its callback synchronously
 * with a `tx` object built from the SAME `run`/`step`/`ingestedEvent` doubles the top-level
 * client exposes (real Prisma scopes a transaction client separately; that distinction does
 * not matter to anything this file asserts — `telemetry.repository.ts`'s header comment
 * already says the real lock/transaction semantics are `test/*.integration.spec.ts`'s job).
 * `$executeRaw` is a no-op stub — the advisory lock's SQL text is not this seam's concern
 * either.
 */
function fakeTransactionalPrismaService(
  options: {
    existingRun?: unknown;
    existingStep?: unknown;
    alreadyIngestedRows?: ReadonlyArray<{ eventId: string }>;
  } = {},
): {
  prisma: PrismaService;
  run: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn<(args: RunUpdateManyArgs) => Promise<{ count: number }>>>;
  };
  step: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  ingestedEvent: {
    findMany: ReturnType<typeof vi.fn<(args: IngestedEventFindManyArgs) => Promise<unknown[]>>>;
    createMany: ReturnType<typeof vi.fn<(args: IngestedEventCreateManyArgs) => Promise<unknown>>>;
  };
} {
  const run = {
    findUnique: vi.fn(() => Promise.resolve(options.existingRun ?? null)),
    upsert: vi.fn(() => Promise.resolve()),
    updateMany: vi.fn<(args: RunUpdateManyArgs) => Promise<{ count: number }>>(() =>
      Promise.resolve({ count: 1 }),
    ),
  };
  const step = {
    findUnique: vi.fn(() => Promise.resolve(options.existingStep ?? null)),
    upsert: vi.fn(() => Promise.resolve()),
  };
  const ingestedEvent = {
    findMany: vi.fn<(args: IngestedEventFindManyArgs) => Promise<unknown[]>>(() =>
      Promise.resolve([...(options.alreadyIngestedRows ?? [])]),
    ),
    createMany: vi.fn<(args: IngestedEventCreateManyArgs) => Promise<unknown>>(() =>
      Promise.resolve({ count: 0 }),
    ),
  };
  const tx = { run, step, ingestedEvent, $executeRaw: vi.fn(() => Promise.resolve()) };
  const client = {
    run,
    step,
    ingestedEvent,
    $transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
  const prisma = { client } as unknown as PrismaService;
  return { prisma, run, step, ingestedEvent };
}

function baseState(overrides: Partial<EntityMergeState> = {}): EntityMergeState {
  return {
    entityId: 'run-1',
    status: 'RUNNING',
    startedAt: '2026-08-18T10:00:00.000Z',
    startFields: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: { fromStart: true } },
    completedAt: null,
    completionFields: null,
    completionEventId: null,
    startEventId: 'evt-start',
    completionFieldOrigins: {},
    lastEventAt: 1_000,
    ...overrides,
  };
}

describe('TelemetryRepository.loadRun', () => {
  it('returns undefined when no row exists', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue(null);
    const repository = new TelemetryRepository(prisma);

    await expect(repository.loadRun('missing')).resolves.toBeUndefined();
  });

  it('maps a row with no completion yet — startFields carries the metadata column', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'RUNNING',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: null,
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:00:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: null,
      metadata: { fromStart: true },
      completionFieldOrigins: {},
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.status).toBe('RUNNING');
    expect(state?.startFields).toEqual({
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      metadata: { fromStart: true },
    });
    expect(state?.completionFields).toBeNull();
  });

  it('maps a row where a completion has claimed the metadata key — completionFields carries it, startFields does not', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'COMPLETED',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: new Date('2026-08-18T10:05:00.000Z'),
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:05:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: 'evt-complete',
      metadata: { fromCompletion: true },
      completionFieldOrigins: {
        metadata: { occurredAt: '2026-08-18T10:05:00.000Z', eventId: 'evt-complete' },
      },
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.startFields).toEqual({ workflowName: 'wf', workflowVersion: '1.0.0' });
    expect(state?.completionFields).toEqual({ metadata: { fromCompletion: true } });
  });

  it('maps a completed row that never set a metadata key — completionFields is {} not null', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'COMPLETED',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: new Date('2026-08-18T10:05:00.000Z'),
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:05:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: 'evt-complete',
      metadata: null,
      completionFieldOrigins: {},
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.completionFields).toEqual({});
  });
});

describe('TelemetryRepository.saveRun', () => {
  it('creates with id/traceId/receivedAt, and never sends receivedAt on update', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun('run-1', baseState());

    expect(run.upsert).toHaveBeenCalledTimes(1);
    const call = run.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'run-1' });
    expect(call.create).toMatchObject({ id: 'run-1', traceId: 'run-1' });
    expect(call.create.receivedAt).toBeInstanceOf(Date);
    expect(call.update).not.toHaveProperty('receivedAt');
    expect(call.update).not.toHaveProperty('id');
    expect(call.update).not.toHaveProperty('traceId');
  });

  it('stores start metadata in the shared metadata column before any completion claims it', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun('run-1', baseState());

    const call = run.upsert.mock.calls[0]![0];
    expect(call.update.metadata).toEqual({ fromStart: true });
  });

  it('stores completion metadata in the shared column once completionFieldOrigins claims the key', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun(
      'run-1',
      baseState({
        status: 'COMPLETED',
        completedAt: '2026-08-18T10:05:00.000Z',
        completionFields: { metadata: { fromCompletion: true } },
        completionEventId: 'evt-complete',
        completionFieldOrigins: {
          metadata: { occurredAt: '2026-08-18T10:05:00.000Z', eventId: 'evt-complete' },
        },
      }),
    );

    const call = run.upsert.mock.calls[0]![0];
    expect(call.update.metadata).toEqual({ fromCompletion: true });
  });
});

describe('TelemetryRepository.saveStep', () => {
  it('creates with id/runId/receivedAt, and never sends receivedAt or runId on update', async () => {
    const { prisma, step } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveStep(
      'step-1',
      'run-1',
      baseState({
        entityId: 'step-1',
        startFields: { name: 'do-thing', agentName: 'agent', type: 'tool', parentStepId: null },
      }),
    );

    expect(step.upsert).toHaveBeenCalledTimes(1);
    const call = step.upsert.mock.calls[0]![0];
    expect(call.create).toMatchObject({ id: 'step-1', runId: 'run-1' });
    expect(call.create.receivedAt).toBeInstanceOf(Date);
    expect(call.update).not.toHaveProperty('receivedAt');
    expect(call.update).not.toHaveProperty('runId');
  });
});

// F3 (ADR 0009, ADR 0005 §1): the ledger plumbing `withEntityLock` adds around the existing
// load-fold-save round trip. The seam under test is what THIS repository sends to and reads
// from `client.ingestedEvent` — not the real advisory lock or the real transaction boundary
// (`test/*.integration.spec.ts`'s job, per this file's header comment).
describe('TelemetryRepository.withEntityLock — IngestedEvent ledger (F3, ADR 0009)', () => {
  it("scopes the ledger lookup to this runId and this batch's eventIds", async () => {
    const { prisma, ingestedEvent } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock(
      'run',
      'run-1',
      'run-1',
      ['a', 'b'],
      1_000,
      (existing, seen) => ({
        state: undefined,
        newlyIngestedEventIds: [],
        value: { existing, seen },
      }),
    );

    expect(ingestedEvent.findMany).toHaveBeenCalledTimes(1);
    const call = ingestedEvent.findMany.mock.calls[0]![0];
    expect(call.where).toEqual({ runId: 'run-1', eventId: { in: ['a', 'b'] } });
  });

  it('passes fold exactly the eventIds the ledger already has recorded, as a Set', async () => {
    const { prisma } = fakeTransactionalPrismaService({
      alreadyIngestedRows: [{ eventId: 'a' }],
    });
    const repository = new TelemetryRepository(prisma);

    const seenSets: ReadonlySet<string>[] = [];
    await repository.withEntityLock(
      'run',
      'run-1',
      'run-1',
      ['a', 'b'],
      1_000,
      (_existing, seen) => {
        seenSets.push(seen);
        return { state: undefined, newlyIngestedEventIds: [], value: undefined };
      },
    );

    expect(seenSets).toHaveLength(1);
    expect(seenSets[0]).toEqual(new Set(['a']));
  });

  it('records every eventId fold reports as newly ingested, winners and losers of the merge alike', async () => {
    const { prisma, ingestedEvent } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('run', 'run-1', 'run-1', ['winner', 'loser'], 5_000, () => ({
      state: baseState(),
      // Both accepted this fold, regardless of which one the merge itself preferred —
      // exactly the F3 gap: the OLD code derived this list from entity-state provenance
      // (winners only), this repository is handed the list directly instead.
      newlyIngestedEventIds: ['winner', 'loser'],
      value: undefined,
    }));

    expect(ingestedEvent.createMany).toHaveBeenCalledTimes(1);
    const call = ingestedEvent.createMany.mock.calls[0]![0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toEqual([
      { eventId: 'winner', runId: 'run-1', receivedAt: new Date(5_000) },
      { eventId: 'loser', runId: 'run-1', receivedAt: new Date(5_000) },
    ]);
  });

  it('does not call createMany when every event in the group was a duplicate', async () => {
    const { prisma, ingestedEvent } = fakeTransactionalPrismaService({
      alreadyIngestedRows: [{ eventId: 'a' }],
    });
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('run', 'run-1', 'run-1', ['a'], 1_000, () => ({
      state: undefined,
      newlyIngestedEventIds: [],
      value: undefined,
    }));

    expect(ingestedEvent.createMany).not.toHaveBeenCalled();
  });
});

/**
 * `p2.run-liveness`. A `step.*` event's ENTITY is the Step, so the per-entity fold can only
 * ever advance the Step's state — and Step has no `lastEventAt` column at all
 * (schema.prisma:144: "liveness is a Run concept"). Before this fix, a run emitting nothing
 * but steps left `Run.lastEventAt` frozen at its last run-level event and derived as STALE
 * (§13) while genuinely alive, which "excludes it from all historical aggregation".
 *
 * Reproduced first through the real ingestion path against a real Postgres
 * (`.artifacts/evidence/2/run-liveness/01-red-reproduction.txt`: `Run.lastEventAt` stayed at
 * the `run.started` clock, 299ms behind the step that followed it). This file pins the seam
 * that fix lives at — WHAT `withEntityLock` sends the client — because `pnpm test` must keep
 * working with no database at all (`vitest.config.mts`'s own header).
 */
describe('TelemetryRepository.withEntityLock — run liveness for step events (p2.run-liveness)', () => {
  it('advances the run row to this request receivedAt when a step group accepts an event', async () => {
    const { prisma, run } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('step', 'step-1', 'run-1', ['evt-a'], 7_000, () => ({
      state: baseState({ entityId: 'step-1', lastEventAt: 7_000 }),
      newlyIngestedEventIds: ['evt-a'],
      value: undefined,
    }));

    expect(run.updateMany).toHaveBeenCalledTimes(1);
    const call = run.updateMany.mock.calls[0]![0];
    expect(call.where.id).toBe('run-1');
    expect(call.data.lastEventAt).toEqual(new Date(7_000));
  });

  it('guards the advance so it can only move forward — the update is conditional on the stored value being older', async () => {
    // Monotonicity is `merge-rules.ts`'s `Math.max`, expressed as a WHERE clause so the
    // database enforces it against whatever a concurrent writer committed rather than
    // against a value this process read earlier. `merge-rules.spec.ts:579` pins the same
    // invariant on the run-event side.
    const { prisma, run } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('step', 'step-1', 'run-1', ['evt-a'], 7_000, () => ({
      state: baseState({ entityId: 'step-1' }),
      newlyIngestedEventIds: ['evt-a'],
      value: undefined,
    }));

    const call = run.updateMany.mock.calls[0]![0];
    expect(call.where.lastEventAt).toEqual({ lt: new Date(7_000) });
  });

  it('does NOT advance run liveness when every step event in the group was a duplicate', async () => {
    // ADR 0009 / ADR 0005 §1. A replayed batch must not be able to keep a dead run looking
    // alive: the ledger already knows this eventId, the fold accepts nothing, and liveness
    // must not move.
    const { prisma, run, ingestedEvent } = fakeTransactionalPrismaService({
      alreadyIngestedRows: [{ eventId: 'evt-a' }],
    });
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('step', 'step-1', 'run-1', ['evt-a'], 9_000, (existing) => ({
      state: existing,
      newlyIngestedEventIds: [],
      value: undefined,
    }));

    expect(run.updateMany).not.toHaveBeenCalled();
    expect(ingestedEvent.createMany).not.toHaveBeenCalled();
  });

  it('never creates a Run row for an orphan step — the advance is an update, never an upsert', async () => {
    // schema.prisma is explicit that Step has NO foreign key to Run because "a stub `Run`
    // cannot be conjured: the workflow fields live only on the start payload". A step whose
    // run has not been seen yet must still land, and must leave the Run table untouched.
    const { prisma, run, step } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('step', 'step-1', 'orphan-run', ['evt-a'], 7_000, () => ({
      state: baseState({ entityId: 'step-1' }),
      newlyIngestedEventIds: ['evt-a'],
      value: undefined,
    }));

    expect(run.upsert).not.toHaveBeenCalled();
    // The step's own row is still written exactly as before.
    expect(step.upsert).toHaveBeenCalledTimes(1);
  });

  it('leaves a run group alone — its own fold already owns lastEventAt, so no second write', async () => {
    const { prisma, run } = fakeTransactionalPrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.withEntityLock('run', 'run-1', 'run-1', ['evt-a'], 7_000, () => ({
      state: baseState(),
      newlyIngestedEventIds: ['evt-a'],
      value: undefined,
    }));

    expect(run.updateMany).not.toHaveBeenCalled();
    expect(run.upsert).toHaveBeenCalledTimes(1);
  });
});
