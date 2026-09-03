import {
  InternalServerErrorException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { EntityMergeState } from './merge-rules';
import { TelemetryService } from './telemetry.service';
import type { TelemetryRepository } from './telemetry.repository';
import type { MergeableEntityKind } from './event-mapping';
import * as eventMapping from './event-mapping';
import type { DecisionsService } from '../decisions/decisions.service';
import type { ModelCallService } from '../model-call/model-call.service';
import type { ToolCallService } from '../tool-call/tool-call.service';
import type { ErrorService } from '../error/error.service';

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
 * `TelemetryService.ingest` the same "load, fold, save-and-record, return the fold's value"
 * contract the real repository provides.
 *
 * `ledger` (F3, ADR 0009/0005 §1) is a SEPARATE map from `runs`/`steps`, keyed by `runId`,
 * deliberately independent of entity-state provenance — mirroring the real
 * `IngestedEvent` table rather than deriving "seen" from `startEventId`/`completionEventId`/
 * `completionFieldOrigins`. It only ever grows via `newlyIngestedEventIds`, exactly the
 * events the real repository would `createMany` into the ledger, so a repost of an event
 * that never won any field on its entity is still remembered here — the shape the fake HAS
 * to have for the F3 regression test below to be able to fail for the right reason.
 *
 * `failFor` (keyed `kind:entityId`, matching `TelemetryService`'s own grouping key) makes
 * ONE entity's `withEntityLock` call reject instead of folding/saving — the seam
 * `TelemetryService`'s persistence-failure classification (ADR 0010) is tested through,
 * without a real Prisma error ever crossing this boundary.
 */
function fakeRepository(
  options: { failFor?: Map<string, unknown>; dropFoldFailFor?: Set<string> } = {},
): {
  repository: TelemetryRepository;
  runs: Map<string, EntityMergeState>;
  steps: Map<string, { runId: string; state: EntityMergeState }>;
  ledger: Map<string, Set<string>>;
  droppedCounts: Map<string, number>;
  saveRunCalls: number;
  saveStepCalls: number;
} {
  const runs = new Map<string, EntityMergeState>();
  const steps = new Map<string, { runId: string; state: EntityMergeState }>();
  const ledger = new Map<string, Set<string>>();
  const droppedCounts = new Map<string, number>();
  const failFor = options.failFor ?? new Map<string, unknown>();
  // F1 second half (Tester, Phase 4 phase gate repair attempt 2): runIds named here make
  // `incrementDroppedCount` reject, the same shape a poisoned key or a transient connection
  // error would produce against real Postgres, without needing either.
  const dropFoldFailFor = options.dropFoldFailFor ?? new Set<string>();
  let saveRunCalls = 0;
  let saveStepCalls = 0;

  const repository = {
    // ADR 0014 decision 2. A plain accumulator — the real repository's COALESCE-based SQL
    // and its S1 replay-ledger idempotency (`telemetry.repository.ts`'s
    // `incrementDroppedCount`) are Postgres's own concern, exercised against the real schema
    // by `test/*.integration.spec.ts` (the replay case specifically, by the S1 regression
    // test there); this fake only has to give `TelemetryService` the same "adds to a per-run
    // running total" contract. `deliveryId`/`receivedAt` are accepted and ignored — nothing
    // at this seam depends on replay idempotency, which is exactly why it cannot be proven
    // here.
    incrementDroppedCount: (
      runId: string,
      amount: number,
      _deliveryId?: string,
      _receivedAt?: Date,
    ): Promise<void> => {
      if (dropFoldFailFor.has(runId)) {
        return Promise.reject(new Error(`fake drop-fold failure for ${runId}`));
      }
      droppedCounts.set(runId, (droppedCounts.get(runId) ?? 0) + amount);
      return Promise.resolve();
    },
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
      kind: MergeableEntityKind,
      entityId: string,
      runId: string,
      eventIds: readonly string[],
      _receivedAt: number,
      fold: (
        existing: EntityMergeState | undefined,
        alreadyIngested: ReadonlySet<string>,
      ) => {
        state: EntityMergeState | undefined;
        newlyIngestedEventIds: readonly string[];
        value: T;
      },
    ): Promise<T> => {
      const failure = failFor.get(`${kind}:${entityId}`);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const existing = kind === 'run' ? runs.get(entityId) : steps.get(entityId)?.state;
      const runLedger = ledger.get(runId) ?? new Set<string>();
      const alreadyIngested = new Set(eventIds.filter((id) => runLedger.has(id)));
      const { state, newlyIngestedEventIds, value } = fold(existing, alreadyIngested);
      if (state !== undefined) {
        if (kind === 'run') {
          saveRunCalls++;
          runs.set(entityId, state);
        } else {
          saveStepCalls++;
          steps.set(entityId, { runId, state });
        }
      }
      if (newlyIngestedEventIds.length > 0) {
        const updated = ledger.get(runId) ?? new Set<string>();
        for (const id of newlyIngestedEventIds) updated.add(id);
        ledger.set(runId, updated);
      }
      return Promise.resolve(value);
    },
  } as unknown as TelemetryRepository;

  return {
    repository,
    runs,
    steps,
    ledger,
    droppedCounts,
    get saveRunCalls() {
      return saveRunCalls;
    },
    get saveStepCalls() {
      return saveStepCalls;
    },
  };
}

/**
 * In-memory doubles for the four ADR 0014 entity-write services `TelemetryService` now
 * dispatches non-mergeable events to. Records every call it receives (method + entityId) so
 * a test can assert routing without a database, and can be made to reject one entityId to
 * exercise the same persistence-failure classification (ADR 0010) the Run/Step groups get.
 */
interface EntityWriterCall {
  readonly method:
    | 'decisions.record'
    | 'decisions.attestOutcome'
    | 'modelCalls.record'
    | 'toolCalls.record'
    | 'errors.record';
  readonly entityId: string;
}

function fakeEntityWriters(options: { failFor?: Set<string> } = {}): {
  decisions: DecisionsService;
  modelCalls: ModelCallService;
  toolCalls: ToolCallService;
  errors: ErrorService;
  calls: EntityWriterCall[];
} {
  const failFor = options.failFor ?? new Set<string>();
  const calls: EntityWriterCall[] = [];

  function writer(method: EntityWriterCall['method']) {
    return (event: { entityId: string }): Promise<void> => {
      calls.push({ method, entityId: event.entityId });
      if (failFor.has(event.entityId)) {
        return Promise.reject(new Error(`fake persistence failure for ${event.entityId}`));
      }
      return Promise.resolve();
    };
  }

  return {
    decisions: {
      record: writer('decisions.record'),
      attestOutcome: writer('decisions.attestOutcome'),
    } as unknown as DecisionsService,
    modelCalls: { record: writer('modelCalls.record') } as unknown as ModelCallService,
    toolCalls: { record: writer('toolCalls.record') } as unknown as ToolCallService,
    errors: { record: writer('errors.record') } as unknown as ErrorService,
    calls,
  };
}

/**
 * Builds the real `TelemetryService` under a fake `TelemetryRepository` and fake entity
 * writers. Named distinctly from the many local `service` variables below (`new
 * TelemetryService(...)` used to be inlined at each call site) rather than `service`, so
 * every existing test keeps its own local `const service = ...` untouched.
 */
function createTelemetryService(
  repository: TelemetryRepository,
  entities: ReturnType<typeof fakeEntityWriters> = fakeEntityWriters(),
): TelemetryService {
  return new TelemetryService(
    repository,
    entities.decisions,
    entities.modelCalls,
    entities.toolCalls,
    entities.errors,
  );
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

function decisionRecordedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-decision-1',
    schemaVersion: '2',
    type: 'decision.recorded',
    entityId: 'dec-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:02:00.000Z',
    payload: {
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
    },
    ...overrides,
  };
}

// ADR 0014 (p4.entity-ingest): this suite used to ASSERT the rejection of all five Phase 4
// types (`telemetry.service.spec.ts:255`, pre-packet). The ADR's "Consequences" section
// authorises reversing that pin explicitly: "That suite is reversed by `p4.entity-ingest`,
// deliberately and with the reversal stated in its handoff... here the pin recorded a
// temporary state and the ADR is its release." This is that reversal.
describe('TelemetryService.ingest — Phase 4 entity types are ingested (ADR 0014)', () => {
  const attestationEvent = {
    eventId: 'evt-attest-1',
    schemaVersion: '2',
    type: 'decision.outcome_attested',
    entityId: 'dec-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:03:00.000Z',
    payload: { outcome: 'SUCCESS' },
  };

  const modelCallEvent = {
    eventId: 'evt-model-1',
    schemaVersion: '2',
    type: 'model_call.recorded',
    entityId: 'mc-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:04:00.000Z',
    payload: {
      stepId: 'step-1',
      provider: 'anthropic',
      model: 'claude',
      latencyMs: 12,
      status: 'OK',
    },
  };

  const toolCallEvent = {
    eventId: 'evt-tool-1',
    schemaVersion: '2',
    type: 'tool_call.recorded',
    entityId: 'tc-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:05:00.000Z',
    payload: {
      stepId: 'step-1',
      toolName: 'search',
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 0,
      outputBytes: 0,
      startedAt: '2026-08-30T10:05:00.000Z',
      completedAt: '2026-08-30T10:05:00.005Z',
      durationMs: 5,
      success: true,
    },
  };

  const errorEvent = {
    eventId: 'evt-error-1',
    schemaVersion: '2',
    type: 'error.recorded',
    entityId: 'err-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:06:00.000Z',
    payload: { stepId: 'step-1', type: 'TimeoutError', message: 'timed out' },
  };

  const phase4Events: readonly (readonly [string, Record<string, unknown>, EntityWriterCall])[] = [
    [
      'decision.recorded',
      decisionRecordedEvent(),
      { method: 'decisions.record', entityId: 'dec-1' },
    ],
    [
      'decision.outcome_attested',
      attestationEvent,
      { method: 'decisions.attestOutcome', entityId: 'dec-1' },
    ],
    ['model_call.recorded', modelCallEvent, { method: 'modelCalls.record', entityId: 'mc-1' }],
    ['tool_call.recorded', toolCallEvent, { method: 'toolCalls.record', entityId: 'tc-1' }],
    ['error.recorded', errorEvent, { method: 'errors.record', entityId: 'err-1' }],
  ];

  for (const [type, event, expectedCall] of phase4Events) {
    it(`accepts ${type} and routes it to its own writer`, async () => {
      const { repository } = fakeRepository();
      const entities = fakeEntityWriters();
      const service = createTelemetryService(repository, entities);

      const response = await service.ingest([event]);

      expect(response.accepted).toBe(1);
      expect(response.rejected).toBe(0);
      expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
      expect(entities.calls).toStrictEqual([expectedCall]);
    });
  }

  // The regression this test used to guard against — `type.startsWith('run.') ? 'run' :
  // 'step'` routing a Decision id into the Step table, ACCEPTED, with every gate green — is
  // now guarded from the OTHER direction: a decision.recorded event must land on the
  // Decision writer and MUST NOT touch Run or Step at all. Asserting on the stores rather
  // than only on the response code is what makes this test able to fail either way.
  it('writes a Decision, and still no Step or Run row, for a decision.recorded event', async () => {
    // `saveStepCalls` is read off the object, not destructured: it is a getter, and
    // destructuring would snapshot 0 before `ingest` ever ran — an assertion that cannot fail.
    const fake = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(fake.repository, entities);

    await service.ingest([decisionRecordedEvent()]);

    expect(fake.steps.size).toBe(0);
    expect(fake.runs.size).toBe(0);
    expect(fake.saveStepCalls).toBe(0);
    expect(entities.calls).toStrictEqual([{ method: 'decisions.record', entityId: 'dec-1' }]);
  });

  it('accepts a decision event alongside a run event in the same batch, both landing', async () => {
    const { repository, runs } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    const response = await service.ingest([decisionRecordedEvent(), runStartedEvent()]);

    expect(response.rejected).toBe(0);
    expect(response.accepted).toBe(2);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.results[1]).toMatchObject({ status: 'ACCEPTED' });
    expect(runs.has('run-1')).toBe(true);
    expect(entities.calls).toStrictEqual([{ method: 'decisions.record', entityId: 'dec-1' }]);
  });

  // DoD line 4 (`MVP_PLAN_V3.md:1806`): an attestation posted from a second process updates
  // the ORIGINAL Decision row rather than inserting a second one. Modelled here as two
  // separate `ingest` calls (two separate requests, as a second process would make), through
  // the SAME fake store, so this is a statement about the store converging on one row —
  // `decisions.repository.spec.ts` already proves the upsert query itself is correct; this
  // proves the ingest path actually reaches it for both event types in the right order.
  it('DoD: an attestation from a second ingest call updates the original Decision, not a second row', async () => {
    const fake = fakeRepository();
    const store = new Map<string, { runId: string; outcome: string }>();
    const decisions = {
      record: (event: { entityId: string; runId: string }): Promise<void> => {
        store.set(event.entityId, { runId: event.runId, outcome: 'UNKNOWN' });
        return Promise.resolve();
      },
      attestOutcome: (event: {
        entityId: string;
        runId: string;
        payload: { outcome: string };
      }): Promise<void> => {
        const existing = store.get(event.entityId);
        store.set(event.entityId, {
          runId: existing?.runId ?? event.runId,
          outcome: event.payload.outcome,
        });
        return Promise.resolve();
      },
    } as unknown as DecisionsService;
    const entities = { ...fakeEntityWriters(), decisions };
    const service = createTelemetryService(fake.repository, entities);

    await service.ingest([decisionRecordedEvent()]);
    await service.ingest([attestationEvent]);

    expect(store.size).toBe(1);
    expect(store.get('dec-1')).toStrictEqual({ runId: 'run-1', outcome: 'SUCCESS' });
  });

  // DoD line 5 (`MVP_PLAN_V3.md:1807`): an attestation for an UNKNOWN decisionId is accepted
  // and stored, not rejected — even when no `decision.recorded` event has ever been ingested
  // for it. `decisions.repository.spec.ts` proves the upsert's `create` branch does this;
  // this proves the ingest path does not gate on the decision existing before reaching it.
  it('DoD: an attestation for a decisionId the platform has never seen is accepted and stored', async () => {
    const fake = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(fake.repository, entities);

    const response = await service.ingest([
      { ...attestationEvent, entityId: 'decision-never-recorded', eventId: 'evt-attest-cold' },
    ]);

    expect(response.accepted).toBe(1);
    expect(response.rejected).toBe(0);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(entities.calls).toStrictEqual([
      { method: 'decisions.attestOutcome', entityId: 'decision-never-recorded' },
    ]);
  });

  // ADR 0014 Consequences: "`EVENT_TYPE_NOT_INGESTIBLE` stays in `INGEST_ERROR_CODES` and
  // stays exercised — a tenth, genuinely unstorable type must still reject per-event rather
  // than fail the batch." All nine real wire types are storable after this packet
  // (`event-mapping.spec.ts` pins that), so there is no real event left that can reach this
  // branch — `entityKindOf` is mocked here to answer `null` for one real type, standing in
  // for a future type whose persistence has not landed yet, exactly the shape these five
  // were before this packet. This is the inverted form of the old
  // "rejects the decision event without affecting a run event in the same batch" case.
  it('a genuinely unstorable type rejects only itself, without affecting a run event in the same batch', async () => {
    const realEntityKindOf = eventMapping.entityKindOf;
    const kindSpy = vi
      .spyOn(eventMapping, 'entityKindOf')
      .mockImplementation((type) => (type === 'error.recorded' ? null : realEntityKindOf(type)));

    try {
      const { repository, runs } = fakeRepository();
      const entities = fakeEntityWriters();
      const service = createTelemetryService(repository, entities);

      const response = await service.ingest([errorEvent, runStartedEvent()]);

      expect(response.rejected).toBe(1);
      expect(response.accepted).toBe(1);
      expect(response.results[0]?.error?.code).toBe('EVENT_TYPE_NOT_INGESTIBLE');
      expect(response.results[1]).toMatchObject({ status: 'ACCEPTED' });
      expect(runs.has('run-1')).toBe(true);
      // The rejected event never reached any writer.
      expect(entities.calls).toStrictEqual([]);
    } finally {
      kindSpy.mockRestore();
    }
  });

  it('an entity-write persistence failure classifies and aborts the whole response, never an event-level REJECTED (ADR 0010)', async () => {
    const { repository } = fakeRepository();
    const entities = fakeEntityWriters({ failFor: new Set(['dec-1']) });
    const service = createTelemetryService(repository, entities);

    await expect(service.ingest([decisionRecordedEvent()])).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('TelemetryService.ingest — event-level rejection never fails the batch', () => {
  it('rejects a malformed event (missing eventId) without affecting a valid neighbour', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);
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
    const service = createTelemetryService(repository);

    const response = await service.ingest([runStartedEvent({ type: 'run.exploded' })]);

    expect(response.rejected).toBe(1);
    expect(response.results[0]?.error?.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it('rejects an event whose payload fails its Zod schema', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);

    const response = await service.ingest([
      runStartedEvent({ payload: { workflowName: 'wf' /* workflowVersion missing */ } }),
    ]);

    expect(response.rejected).toBe(1);
    expect(response.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects an event over the 64KB single-event payload limit (ADR 0006), event-level not request-level', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);
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
    const service = createTelemetryService(fake.repository);

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
    const service = createTelemetryService(fake.repository);

    await service.ingest([runStartedEvent(), stepStartedEvent()]);

    expect(fake.saveRunCalls).toBe(1);
    expect(fake.saveStepCalls).toBe(1);
    expect(fake.steps.get('step-1')?.runId).toBe('run-1');
  });

  it('a completion event for an unseen entity creates it already terminal (§12 out-of-order rule)', async () => {
    const { repository, runs } = fakeRepository();
    const service = createTelemetryService(repository);

    const response = await service.ingest([runCompletedEvent({ payload: { status: 'FAILED' } })]);

    expect(response.accepted).toBe(1);
    expect(runs.get('run-1')?.status).toBe('FAILED');
    expect(runs.get('run-1')?.startedAt).toBeNull();
  });
});

describe('TelemetryService.ingest — idempotency (§12: re-posting a known eventId is a no-op)', () => {
  it('classifies a repeat of the same eventId within one batch as DUPLICATE, not a second ACCEPTED', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);
    const event = runStartedEvent();

    const response = await service.ingest([event, { ...event }]);

    expect(response.accepted).toBe(1);
    expect(response.duplicate).toBe(1);
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.results[1]).toMatchObject({ status: 'DUPLICATE' });
  });

  it('classifies a repeat of a known eventId from a PRIOR request as DUPLICATE', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);
    await service.ingest([runStartedEvent()]);

    const response = await service.ingest([runStartedEvent()]);

    expect(response.duplicate).toBe(1);
    expect(response.accepted).toBe(0);
    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE' });
  });

  it('does not create a new row and does not error on a duplicate — the entity state is unchanged', async () => {
    const { repository, runs } = fakeRepository();
    const service = createTelemetryService(repository);
    await service.ingest([runStartedEvent()]);
    const before = runs.get('run-1');

    const response = await service.ingest([runStartedEvent()]);

    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE' });
    expect(response.rejected).toBe(0);
    expect(runs.size).toBe(1);
    expect(runs.get('run-1')?.startedAt).toBe(before?.startedAt);
  });

  // F3 (ADR 0009, corrected A-7): the ledger-backed regression. `collectKnownEventIds`
  // used to reconstruct "seen" from Run/Step's own provenance columns, which record only
  // the WINNER of each merge contest — an event that loses (here: a later start event,
  // beaten by `shouldReplaceStart`'s first-writer-wins-by-occurredAt rule) left no trace on
  // the row and was misclassified ACCEPTED on every replay, forever
  // (`.artifacts/evidence/2/tester-reverify/raw/f3.out` D2.2/D2.3). Expected value for this
  // test is sourced from ADR 0009's Decision §1 verbatim ("A-7's `accepted: 0, duplicate: N`
  // on a replayed batch... remain the required behaviour") and its Detection block ("must
  // flip from `accepted:2, duplicate:2` to `accepted:0, duplicate:4`" for a 4-event batch) —
  // not from this implementation's own arithmetic.
  it('replaying a batch with a start event that LOST the first-writer-wins tie is DUPLICATE on replay, not ACCEPTED again (F3, ADR 0009)', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);
    // 'late-loser' occurs AFTER 'early-winner', so shouldReplaceStart rejects it — it never
    // becomes startEventId and (being a start event) can win no completionFieldOrigins
    // either. Under the old entity-state-derived `seen`, it is invisible on every replay.
    const winner = runStartedEvent({
      eventId: 'early-winner',
      occurredAt: '2026-08-18T09:00:00.000Z',
    });
    const loser = runStartedEvent({
      eventId: 'late-loser',
      occurredAt: '2026-08-18T09:05:00.000Z',
    });

    const first = await service.ingest([winner, loser]);
    expect(first.accepted).toBe(2);
    expect(first.duplicate).toBe(0);

    const second = await service.ingest([winner, loser]);

    expect(second.accepted).toBe(0);
    expect(second.duplicate).toBe(2);
    expect(second.results[0]).toMatchObject({ eventId: 'early-winner', status: 'DUPLICATE' });
    expect(second.results[1]).toMatchObject({ eventId: 'late-loser', status: 'DUPLICATE' });

    // Stability, not just one-shot convergence — the D2.3 shape ADR 0009 names ("stable,
    // not converging" was the BUG; a real fix stays converged on a third replay too).
    const third = await service.ingest([winner, loser]);
    expect(third.accepted).toBe(0);
    expect(third.duplicate).toBe(2);
  });
});

describe('TelemetryService.ingest — response shape', () => {
  it('returns a batchId and counts that sum to the number of events submitted', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);
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

describe('TelemetryService.ingest — droppedSinceLastBatch (ADR 0014 decision 2)', () => {
  it('folds the drop count into the run named by the batch’s own events', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([runStartedEvent()], 3);

    expect(droppedCounts.get('run-1')).toBe(3);
  });

  it('does not touch the store when the field is absent — never a manufactured zero', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([runStartedEvent()]);

    expect(droppedCounts.size).toBe(0);
  });

  it('reports a real zero the same way as any other reported count, once the field is present', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([runStartedEvent()], 0);

    expect(droppedCounts.get('run-1')).toBe(0);
  });

  it('credits the run once per batch, not once per event for that run', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([runStartedEvent(), runCompletedEvent()], 5);

    expect(droppedCounts.get('run-1')).toBe(5);
  });

  it('credits every run the batch actually names when it spans more than one', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest(
      [
        runStartedEvent({ entityId: 'run-a', runId: 'run-a' }),
        runStartedEvent({ entityId: 'run-b', runId: 'run-b' }),
      ],
      2,
    );

    expect(droppedCounts.get('run-a')).toBe(2);
    expect(droppedCounts.get('run-b')).toBe(2);
  });

  it('accumulates across separate ingest calls, run-summary being a running total not a snapshot', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([runStartedEvent()], 2);
    await service.ingest([runCompletedEvent()], 5);

    expect(droppedCounts.get('run-1')).toBe(7);
  });

  it('applies even when the batch contains only Phase 4 entity events, no Run/Step event', async () => {
    const { repository, droppedCounts } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    await service.ingest([decisionRecordedEvent()], 4);

    expect(droppedCounts.get('run-1')).toBe(4);
  });

  /**
   * F1 second half (Tester, Phase 4 phase gate repair attempt 2). The third recurrence of
   * one class (R1, R4, S1 before it): a post-commit fold must never turn work that already
   * landed into an unclassified 500. `incrementDroppedCount` runs AFTER the event above has
   * already been folded and (in the real repository) saved — a failure here must be
   * contained and reported, never allowed to discard `results` for an event that committed.
   */
  it('a drop-count fold failure does not throw — the event it was folded for still reports its real result', async () => {
    const { repository } = fakeRepository({ dropFoldFailFor: new Set(['run-1']) });
    const service = createTelemetryService(repository);

    const response = await service.ingest([runStartedEvent()], 3);

    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(response.accepted).toBe(1);
    expect(response.rejected).toBe(0);
  });

  it('a drop-count fold failure for one run does not suppress the fold for another run the same batch names', async () => {
    const { repository, droppedCounts } = fakeRepository({ dropFoldFailFor: new Set(['run-a']) });
    const service = createTelemetryService(repository);

    const response = await service.ingest(
      [
        runStartedEvent({ entityId: 'run-a', runId: 'run-a' }),
        runStartedEvent({ entityId: 'run-b', runId: 'run-b' }),
      ],
      2,
    );

    expect(response.accepted).toBe(2);
    expect(droppedCounts.get('run-a')).toBeUndefined();
    expect(droppedCounts.get('run-b')).toBe(2);
  });
});

// ADR 0010 (`docs/decisions/0010-infrastructure-failure-is-not-an-event-level-rejection.md`),
// tester findings T1-T5, 2026-08-20.
describe('TelemetryService.ingest — year-0000 occurredAt is an event-level rejection (T2/T3)', () => {
  it('rejects only the year-0000 event; a well-formed sibling in the SAME entity group still persists', async () => {
    const { repository, runs } = fakeRepository();
    const service = createTelemetryService(repository);
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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

    await expect(
      service.ingest([runStartedEvent({ entityId: 'no-meta-run', runId: 'no-meta-run' })]),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('a plain, non-Prisma error (e.g. a RangeError from inside the fold) also throws InternalServerErrorException (500)', async () => {
    const failFor = new Map<string, unknown>([
      ['run:overflow-run', new RangeError('Maximum call stack size exceeded')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = createTelemetryService(repository);

    await expect(
      service.ingest([runStartedEvent({ entityId: 'overflow-run', runId: 'overflow-run' })]),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('never produces a PROCESSING_FAILED code or a REJECTED status for a persistence failure — the whole call rejects instead', async () => {
    const failFor = new Map<string, unknown>([
      ['run:fail-run', fakePrismaError('PrismaClientKnownRequestError', 'P2021')],
    ]);
    const { repository } = fakeRepository({ failFor });
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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
    const service = createTelemetryService(repository);

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

// R1 (Reviewer finding, 2026-09-02, repair attempt 1 on `p4.entity-ingest`). The suite above
// pins the `occurredAt` screen; this one pins the same contract for every OTHER value the
// five Phase 4 types carry into a column narrower than the wire contract. Before the fix each
// of these threw out of `persistEntityWrites` as an HTTP 500 with zero per-event results —
// after the Run/Step groups in the same batch had already committed, so the caller could not
// retry the batch to success either (reproduced against real Postgres, SQLSTATE 22008:
// `.artifacts/evidence/4/p4.entity-ingest/coordinator/s1-confirmation.md`).
describe('TelemetryService.ingest — an unstorable PAYLOAD value is an event-level rejection too (R1)', () => {
  const toolCallEvent = (payload: Record<string, unknown>): Record<string, unknown> => ({
    eventId: 'evt-tool-1',
    schemaVersion: '2',
    type: 'tool_call.recorded',
    entityId: 'tc-1',
    runId: 'run-1',
    occurredAt: '2026-09-02T10:00:05.000Z',
    payload: {
      stepId: 'step-1',
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

  const attestationEvent = (payload: Record<string, unknown>): Record<string, unknown> => ({
    eventId: 'evt-attest-r1',
    schemaVersion: '2',
    type: 'decision.outcome_attested',
    entityId: 'dec-r1',
    runId: 'run-1',
    occurredAt: '2026-09-02T10:00:06.000Z',
    payload: { outcome: 'SUCCESS', ...payload },
  });

  it('rejects a year-0000 startedAt as a per-event REJECTED and never calls the ToolCall writer at all', async () => {
    const { repository } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    const response = await service.ingest([
      toolCallEvent({ startedAt: '0000-01-01T00:00:00.000Z' }),
    ]);

    expect(response.rejected).toBe(1);
    expect(response.accepted).toBe(0);
    expect(response.results[0]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
    expect(response.results[0]?.error?.message).toContain('startedAt');
    // The whole point: the event is stopped BEFORE the entity-write path, so no writer ever
    // sees the value Postgres would have thrown on.
    expect(entities.calls).toStrictEqual([]);
  });

  it('rejects a year-0000 completedAt — the sibling field, not only the one that was reported', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);

    const response = await service.ingest([
      toolCallEvent({ completedAt: '0000-01-01T00:00:00.000Z' }),
    ]);

    expect(response.results[0]?.error?.message).toContain('completedAt');
  });

  it("rejects decision.outcome_attested's year-0000 observedAt", async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);

    const response = await service.ingest([
      attestationEvent({ observedAt: '0000-01-01T00:00:00.000Z' }),
    ]);

    expect(response.results[0]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[0]?.error?.message).toContain('observedAt');
  });

  it('rejects an int4-overflowing durationMs — same seam, same permanent-poison failure (SQLSTATE 22003)', async () => {
    const { repository } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    const response = await service.ingest([toolCallEvent({ durationMs: 2_147_483_648 })]);

    expect(response.results[0]).toMatchObject({ status: 'REJECTED' });
    expect(response.results[0]?.error?.code).toBe('INVALID_PAYLOAD');
    expect(response.results[0]?.error?.message).toContain('durationMs');
    expect(entities.calls).toStrictEqual([]);
  });

  it('rejects an int4-overflowing latencyMs on model_call.recorded', async () => {
    const { repository } = fakeRepository();
    const service = createTelemetryService(repository);

    const response = await service.ingest([
      {
        eventId: 'evt-model-r1',
        schemaVersion: '2',
        type: 'model_call.recorded',
        entityId: 'mc-r1',
        runId: 'run-1',
        occurredAt: '2026-09-02T10:00:07.000Z',
        payload: {
          stepId: 'step-1',
          provider: 'anthropic',
          model: 'claude',
          latencyMs: 2_147_483_648,
          status: 'ok',
        },
      },
    ]);

    expect(response.results[0]?.error?.message).toContain('latencyMs');
  });

  // This is the assertion the whole fix exists for. Before it, the poison event threw out of
  // `ingest` entirely: the Run group had already committed but the caller received NO
  // per-event results for anything, and the identical batch threw again on every retry.
  it('a well-formed sibling in the SAME batch still lands, and ingest does not throw', async () => {
    const { repository, runs } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    const response = await service.ingest([
      runStartedEvent({ entityId: 'run-1', runId: 'run-1' }),
      toolCallEvent({ startedAt: '0000-01-01T00:00:00.000Z' }),
      { ...toolCallEvent({}), eventId: 'evt-tool-good', entityId: 'tc-good' },
    ]);

    expect(response.results.map((r) => r.status)).toStrictEqual([
      'ACCEPTED',
      'REJECTED',
      'ACCEPTED',
    ]);
    expect(response.accepted).toBe(2);
    expect(response.rejected).toBe(1);
    expect(runs.get('run-1')?.startedAt).not.toBeNull();
    expect(entities.calls).toStrictEqual([{ method: 'toolCalls.record', entityId: 'tc-good' }]);
  });

  it('a representable payload is untouched — the control that keeps this screen from rejecting good events', async () => {
    const { repository } = fakeRepository();
    const entities = fakeEntityWriters();
    const service = createTelemetryService(repository, entities);

    const response = await service.ingest([
      toolCallEvent({ durationMs: 2_147_483_647, startedAt: '0001-01-01T00:00:00.000Z' }),
      attestationEvent({ observedAt: '2026-09-02T10:00:06.000Z' }),
    ]);

    expect(response.results.map((r) => r.status)).toStrictEqual(['ACCEPTED', 'ACCEPTED']);
    expect(entities.calls).toStrictEqual([
      { method: 'toolCalls.record', entityId: 'tc-1' },
      { method: 'decisions.attestOutcome', entityId: 'dec-r1' },
    ]);
  });

  // ADR 0014 decision 2: a rejected event still named a run, so that run is still owed its
  // share of the batch's drop count — the same treatment every other post-parse rejection
  // gets.
  it("credits droppedSinceLastBatch to the rejected event's run, like every other post-parse rejection", async () => {
    const { repository, droppedCounts } = fakeRepository();
    const service = createTelemetryService(repository);

    await service.ingest([toolCallEvent({ startedAt: '0000-01-01T00:00:00.000Z' })], 5);

    expect(droppedCounts.get('run-1')).toBe(5);
  });
});
