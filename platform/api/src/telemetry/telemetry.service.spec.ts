import {
  InternalServerErrorException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { EntityMergeState } from './merge-rules';
import { TelemetryService } from './telemetry.service';
import type { TelemetryRepository } from './telemetry.repository';
import type { EntityKind } from './event-mapping';

/**
 * In-memory double for `TelemetryRepository`, keyed the same way `TelemetryService` groups
 * events (`kind:entityId`). Real enough to exercise idempotency and cross-event merge
 * folding without a database: the seam under test is what `TelemetryService` does with the
 * answers a repository gives it, not whether Prisma round-trips correctly, and not whether
 * the real advisory lock actually serializes concurrent transactions (that is
 * `telemetry.repository.ts`'s own concern, exercised against the real schema — and, for the
 * F1 concurrency fix specifically, against real concurrent connections — by
 * `test/*.integration.spec.ts`, not `pnpm test`).
 *
 * `withEntityLock` here is a single-threaded stand-in: no real lock, since a JS test runner
 * never actually interleaves two calls into this fake. It exists to give
 * `TelemetryService.ingest` the same "load, fold, save, return the fold's value" contract
 * the real repository provides.
 *
 * `failFor` (keyed `kind:entityId`, matching `TelemetryService`'s own grouping key) makes
 * ONE entity's `withEntityLock` call reject instead of folding/saving — the seam
 * `TelemetryService`'s persistence-failure classification (ADR 0010) is tested through,
 * without a real Prisma error ever crossing this boundary.
 */
function fakeRepository(options: { failFor?: Map<string, unknown> } = {}): {
  repository: TelemetryRepository;
  runs: Map<string, EntityMergeState>;
  steps: Map<string, { runId: string; state: EntityMergeState }>;
  saveRunCalls: number;
  saveStepCalls: number;
} {
  const runs = new Map<string, EntityMergeState>();
  const steps = new Map<string, { runId: string; state: EntityMergeState }>();
  const failFor = options.failFor ?? new Map<string, unknown>();
  let saveRunCalls = 0;
  let saveStepCalls = 0;

  const repository = {
    loadRun: (id: string) => Promise.resolve(runs.get(id)),
    loadStep: (id: string) => Promise.resolve(steps.get(id)?.state),
    saveRun: (id: string, state: EntityMergeState) => {
      saveRunCalls++;
      runs.set(id, state);
      return Promise.resolve();
    },
    saveStep: (id: string, runId: string, state: EntityMergeState) => {
      saveStepCalls++;
      steps.set(id, { runId, state });
      return Promise.resolve();
    },
    withEntityLock: <T>(
      kind: EntityKind,
      entityId: string,
      runId: string,
      fold: (existing: EntityMergeState | undefined) => {
        state: EntityMergeState | undefined;
        value: T;
      },
    ): Promise<T> => {
      const failure = failFor.get(`${kind}:${entityId}`);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const existing = kind === 'run' ? runs.get(entityId) : steps.get(entityId)?.state;
      const { state, value } = fold(existing);
      if (state !== undefined) {
        if (kind === 'run') {
          saveRunCalls++;
          runs.set(entityId, state);
        } else {
          saveStepCalls++;
          steps.set(entityId, { runId, state });
        }
      }
      return Promise.resolve(value);
    },
  } as unknown as TelemetryRepository;

  return {
    repository,
    runs,
    steps,
    get saveRunCalls() {
      return saveRunCalls;
    },
    get saveStepCalls() {
      return saveStepCalls;
    },
  };
}

function runStartedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-run-start-1',
    schemaVersion: '1',
    type: 'run.started',
    entityId: 'run-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:00:00.000Z',
    payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    ...overrides,
  };
}

function runCompletedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-run-complete-1',
    schemaVersion: '1',
    type: 'run.completed',
    entityId: 'run-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:05:00.000Z',
    payload: { status: 'COMPLETED' },
    ...overrides,
  };
}

function stepStartedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-step-start-1',
    schemaVersion: '1',
    type: 'step.started',
    entityId: 'step-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:01:00.000Z',
    payload: { name: 'do-thing', agentName: 'agent', type: 'tool', parentStepId: null },
    ...overrides,
  };
}

describe('TelemetryService.ingest — event-level rejection never fails the batch', () => {
  it('rejects a malformed event (missing eventId) without affecting a valid neighbour', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);
    const malformed = { ...runStartedEvent() };
    delete (malformed as { eventId?: string }).eventId;

    const response = await service.ingest([
      malformed,
      runStartedEvent({ entityId: 'run-2', runId: 'run-2' }),
    ]);

    expect(response.rejected).toBe(1);
    expect(response.accepted).toBe(1);
    expect(response.results[0]).toMatchObject({ eventId: '', status: 'REJECTED' });
    expect(response.results[0]?.error?.code).toBe('MISSING_REQUIRED_FIELD');
    expect(response.results[1]).toMatchObject({ status: 'ACCEPTED' });
  });

  it('rejects an unknown event type', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);

    const response = await service.ingest([runStartedEvent({ type: 'run.exploded' })]);

    expect(response.rejected).toBe(1);
    expect(response.results[0]?.error?.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it('rejects an event whose payload fails its Zod schema', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);

    const response = await service.ingest([
      runStartedEvent({ payload: { workflowName: 'wf' /* workflowVersion missing */ } }),
    ]);

    expect(response.rejected).toBe(1);
    expect(response.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects an event over the 64KB single-event payload limit (ADR 0006), event-level not request-level', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);
    const huge = runStartedEvent({
      payload: {
        workflowName: 'wf',
        workflowVersion: '1.0.0',
        metadata: { blob: 'x'.repeat(70_000) },
      },
    });

    const response = await service.ingest([
      huge,
      runStartedEvent({ entityId: 'run-2', runId: 'run-2' }),
    ]);

    expect(response.rejected).toBe(1);
    expect(response.accepted).toBe(1);
    expect(response.results[0]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[0]?.error?.code).toBe('EVENT_TOO_LARGE');
    // The other event in the batch is untouched — one bad event never discards its neighbours.
    expect(response.results[1]).toMatchObject({ status: 'ACCEPTED' });
  });
});

describe('TelemetryService.ingest — merge-rules invocation', () => {
  it('folds a start then a completion for the same Run into one saved, terminal state', async () => {
    const fake = fakeRepository();
    const service = new TelemetryService(fake.repository);

    const response = await service.ingest([runStartedEvent(), runCompletedEvent()]);

    expect(response.accepted).toBe(2);
    expect(fake.saveRunCalls).toBe(1); // one upsert per entity, not per event
    const saved = fake.runs.get('run-1');
    expect(saved?.status).toBe('COMPLETED');
    expect(saved?.startedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(saved?.completedAt).toBe('2026-08-18T10:05:00.000Z');
  });

  it('routes run.* and step.* events to separate saves keyed by entity kind', async () => {
    const fake = fakeRepository();
    const service = new TelemetryService(fake.repository);

    await service.ingest([runStartedEvent(), stepStartedEvent()]);

    expect(fake.saveRunCalls).toBe(1);
    expect(fake.saveStepCalls).toBe(1);
    expect(fake.steps.get('step-1')?.runId).toBe('run-1');
  });

  it('a completion event for an unseen entity creates it already terminal (§12 out-of-order rule)', async () => {
    const { repository, runs } = fakeRepository();
    const service = new TelemetryService(repository);

    const response = await service.ingest([runCompletedEvent({ payload: { status: 'FAILED' } })]);

    expect(response.accepted).toBe(1);
    expect(runs.get('run-1')?.status).toBe('FAILED');
    expect(runs.get('run-1')?.startedAt).toBeNull();
  });
});

describe('TelemetryService.ingest — idempotency (§12: re-posting a known eventId is a no-op)', () => {
  it('classifies a repeat of the same eventId within one batch as DUPLICATE, not a second ACCEPTED', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);
    const event = runStartedEvent();

    const response = await service.ingest([event, { ...event }]);

    expect(response.accepted).toBe(1);
    expect(response.duplicate).toBe(1);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.results[1]).toMatchObject({ status: 'DUPLICATE' });
  });

  it('classifies a repeat of a known eventId from a PRIOR request as DUPLICATE', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);
    await service.ingest([runStartedEvent()]);

    const response = await service.ingest([runStartedEvent()]);

    expect(response.duplicate).toBe(1);
    expect(response.accepted).toBe(0);
    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE' });
  });

  it('does not create a new row and does not error on a duplicate — the entity state is unchanged', async () => {
    const { repository, runs } = fakeRepository();
    const service = new TelemetryService(repository);
    await service.ingest([runStartedEvent()]);
    const before = runs.get('run-1');

    const response = await service.ingest([runStartedEvent()]);

    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE' });
    expect(response.rejected).toBe(0);
    expect(runs.size).toBe(1);
    expect(runs.get('run-1')?.startedAt).toBe(before?.startedAt);
  });
});

describe('TelemetryService.ingest — response shape', () => {
  it('returns a batchId and counts that sum to the number of events submitted', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);

    const response = await service.ingest([
      runStartedEvent(),
      { ...runStartedEvent() }, // duplicate of the one above
      { type: 'nope' }, // rejected
    ]);

    expect(typeof response.batchId).toBe('string');
    expect(response.batchId.length).toBeGreaterThan(0);
    expect(response.accepted + response.duplicate + response.rejected).toBe(3);
    expect(response.results).toHaveLength(3);
  });

  it('preserves the original batch order in results, even across mixed accept/reject/duplicate', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);
    const dup = runStartedEvent({ entityId: 'run-9', runId: 'run-9' });

    const response = await service.ingest([
      runStartedEvent({ eventId: 'a' }),
      { type: 'unknown-type' },
      dup,
      { ...dup },
    ]);

    expect(response.results.map((r) => r.status)).toEqual([
      'ACCEPTED',
      'REJECTED',
      'ACCEPTED',
      'DUPLICATE',
    ]);
  });
});

// ADR 0010 (`docs/decisions/0010-infrastructure-failure-is-not-an-event-level-rejection.md`),
// tester findings T1-T5, 2026-08-20.
describe('TelemetryService.ingest — year-0000 occurredAt is an event-level rejection (T2/T3)', () => {
  it('rejects only the year-0000 event; a well-formed sibling in the SAME entity group still persists', async () => {
    const { repository, runs } = fakeRepository();
    const service = new TelemetryService(repository);
    const entityId = 'poison-run';

    const response = await service.ingest([
      runStartedEvent({ entityId, runId: entityId, eventId: 'good' }),
      runCompletedEvent({
        entityId,
        runId: entityId,
        eventId: 'poison',
        occurredAt: '0000-01-01T00:00:00.000Z',
      }),
    ]);

    expect(response.accepted).toBe(1);
    expect(response.rejected).toBe(1);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
    // The group never even attempted to fold/persist the poison event — the well-formed
    // start side is the ONLY thing in the saved state.
    expect(runs.get(entityId)?.startedAt).not.toBeNull();
    expect(runs.get(entityId)?.completedAt).toBeNull();
  });

  it('a good event elsewhere in the same batch is unaffected by a year-0000 sibling in a DIFFERENT entity group', async () => {
    const { repository } = fakeRepository();
    const service = new TelemetryService(repository);

    const response = await service.ingest([
      runStartedEvent({ entityId: 'before', runId: 'before' }),
      runStartedEvent({
        entityId: 'poison',
        runId: 'poison',
        eventId: 'poison-start',
        occurredAt: '0000-06-15T00:00:00.000Z',
      }),
      runStartedEvent({ entityId: 'after', runId: 'after' }),
    ]);

    expect(response.results.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED']);
    expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
  });
});

describe('TelemetryService.ingest — a persistence failure aborts the whole response, never an event-level REJECTED (T1/T3/T4)', () => {
  function fakePrismaError(name: string, code?: string, meta?: unknown): Error {
    const error = new Error(`fake ${name} for classification testing`);
    error.name = name;
    if (code !== undefined) {
      (error as unknown as { code: string }).code = code;
    }
    if (meta !== undefined) {
      (error as unknown as { meta: unknown }).meta = meta;
    }
    return error;
  }

  /**
   * Reproduces the REAL shape Prisma's Postgres driver adapter attaches to a raw-query
   * (P2010) error, verified live via `platform/api/p2010-probe.mts` (throwaway, not
   * committed) against two real Postgres failures on the SAME code path
   * `TelemetryRepository.lockEntity`'s `$executeRaw` uses —
   * `.artifacts/evidence/2/builder-repair-3/p2010-sqlstate-probe.txt`.
   */
  function fakeP2010(sqlState: string): Error {
    return fakePrismaError('PrismaClientKnownRequestError', 'P2010', {
      driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: sqlState } },
    });
  }

  it('a known-dependency-unavailable Prisma error (table missing, P2021) throws ServiceUnavailableException (503)', async () => {
    const failFor = new Map<string, unknown>([
      ['run:down-run', fakePrismaError('PrismaClientKnownRequestError', 'P2021')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    const promise = service.ingest([runStartedEvent({ entityId: 'down-run', runId: 'down-run' })]);

    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    await promise.catch((error: HttpException) => {
      expect(error.getStatus()).toBe(503);
    });
  });

  it('connection-refused (ECONNREFUSED) also classifies as ServiceUnavailableException (503)', async () => {
    const failFor = new Map<string, unknown>([
      ['run:refused-run', fakePrismaError('PrismaClientKnownRequestError', 'ECONNREFUSED')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    await expect(
      service.ingest([runStartedEvent({ entityId: 'refused-run', runId: 'refused-run' })]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // Coordinator finding on the FIRST version of F-5 (2026-08-20, repair attempt 3 round 2):
  // P2010 is Prisma's GENERIC raw-query error — it fires for a statement cancelled under
  // load (transient, retryable) and for a query this service's own code got wrong
  // (permanent defect) alike. Moving P2010 wholesale into the dependency-unavailable set
  // (round 1 of this fix) recreated F-6's non-convergent-retry shape for a different
  // input: a permanently-broken query classified 503 tells a conforming SDK to retry
  // forever. Discriminate on the Postgres SQLSTATE the error actually carries instead.
  it('P2010 whose SQLSTATE is 57014 (statement cancelled under load — the canonical retryable-dependency signal) throws ServiceUnavailableException (503)', async () => {
    const failFor = new Map<string, unknown>([['run:cancelled-run', fakeP2010('57014')]]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    const promise = service.ingest([
      runStartedEvent({ entityId: 'cancelled-run', runId: 'cancelled-run' }),
    ]);

    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    await promise.catch((error: HttpException) => {
      expect(error.getStatus()).toBe(503);
    });
  });

  it('P2010 whose SQLSTATE is 42703 (undefined_column — a genuine query defect, not a dependency condition) throws InternalServerErrorException (500), never 503', async () => {
    const failFor = new Map<string, unknown>([['run:bug-run', fakeP2010('42703')]]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    const promise = service.ingest([runStartedEvent({ entityId: 'bug-run', runId: 'bug-run' })]);

    await expect(promise).rejects.toBeInstanceOf(InternalServerErrorException);
    await promise.catch((error: HttpException) => {
      expect(error.getStatus()).toBe(500);
    });
  });

  it('P2010 with no SQLSTATE reachable on the error object falls through to InternalServerErrorException (500), the conservative default — never guesses 503', async () => {
    const failFor = new Map<string, unknown>([
      ['run:no-meta-run', fakePrismaError('PrismaClientKnownRequestError', 'P2010')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    await expect(
      service.ingest([runStartedEvent({ entityId: 'no-meta-run', runId: 'no-meta-run' })]),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('a plain, non-Prisma error (e.g. a RangeError from inside the fold) also throws InternalServerErrorException (500)', async () => {
    const failFor = new Map<string, unknown>([
      ['run:overflow-run', new RangeError('Maximum call stack size exceeded')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    await expect(
      service.ingest([runStartedEvent({ entityId: 'overflow-run', runId: 'overflow-run' })]),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('never produces a PROCESSING_FAILED code or a REJECTED status for a persistence failure — the whole call rejects instead', async () => {
    const failFor = new Map<string, unknown>([
      ['run:fail-run', fakePrismaError('PrismaClientKnownRequestError', 'P2021')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    let thrown: unknown;
    try {
      await service.ingest([runStartedEvent({ entityId: 'fail-run', runId: 'fail-run' })]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(thrown)).not.toContain('PROCESSING_FAILED');
  });

  it('a group that already committed BEFORE the failing group stays committed, even though the response itself is a 5xx (durability vs what is reported)', async () => {
    const failFor = new Map<string, unknown>([
      ['run:second-fails', fakePrismaError('PrismaClientKnownRequestError', 'P2021')],
    ]);
    const { repository, runs } = fakeRepository({ failFor });
    const service = new TelemetryService(repository);

    await expect(
      service.ingest([
        runStartedEvent({ entityId: 'first-ok', runId: 'first-ok' }),
        runStartedEvent({ entityId: 'second-fails', runId: 'second-fails' }),
      ]),
    ).rejects.toThrow();

    // The FIRST group's own transaction had already completed by the time the SECOND
    // group's `withEntityLock` rejected — its data is durable regardless of how this
    // particular response turned out.
    expect(runs.get('first-ok')?.startedAt).not.toBeNull();
    expect(runs.has('second-fails')).toBe(false);
  });
});

describe('TelemetryService.ingest — deep-metadata recursion is contained per-event, never an uncaught request failure (T5)', () => {
  it('a pathologically deep, Zod-legal metadata object that overflows containsUnsafeUnicode rejects ONLY that event; a well-formed sibling in the same batch still lands', async () => {
    const { repository, runs } = fakeRepository();
    const service = new TelemetryService(repository);

    // Real recursion, not a mock: containsUnsafeUnicode walks this the same way it would a
    // real payload. Depth is deliberately large and unbounded-feeling on purpose — tester
    // finding T5: "depth is not a stable threshold", so this proves the BOUNDARY holds
    // rather than pinning to one number.
    let deeplyNested: unknown = { leaf: true };
    for (let i = 0; i < 200_000; i++) {
      deeplyNested = { child: deeplyNested };
    }

    const response = await service.ingest([
      runStartedEvent({ entityId: 'deep-sibling', runId: 'deep-sibling' }),
      runStartedEvent({
        entityId: 'deep-bad',
        runId: 'deep-bad',
        eventId: 'deep-bad-start',
        payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: deeplyNested },
      }),
    ]);

    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.results[1]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[1]?.error?.code).toBe('INVALID_PAYLOAD');
    expect(response.rejected).toBe(1);
    expect(runs.get('deep-sibling')?.startedAt).not.toBeNull();
    expect(runs.has('deep-bad')).toBe(false);
  });
});
