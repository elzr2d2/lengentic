import { describe, expect, it } from 'vitest';
import type { EntityMergeState } from './merge-rules';
import { TelemetryService } from './telemetry.service';
import type { TelemetryRepository } from './telemetry.repository';

/**
 * In-memory double for `TelemetryRepository`, keyed the same way `TelemetryService` groups
 * events (`kind:entityId`). Real enough to exercise idempotency and cross-event merge
 * folding without a database: the seam under test is what `TelemetryService` does with the
 * answers a repository gives it, not whether Prisma round-trips correctly (that is
 * `telemetry.repository.ts`'s own concern, exercised against the real schema by
 * `test/*.integration.spec.ts`, not `pnpm test`).
 */
function fakeRepository(): {
  repository: TelemetryRepository;
  runs: Map<string, EntityMergeState>;
  steps: Map<string, { runId: string; state: EntityMergeState }>;
  saveRunCalls: number;
  saveStepCalls: number;
} {
  const runs = new Map<string, EntityMergeState>();
  const steps = new Map<string, { runId: string; state: EntityMergeState }>();
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
