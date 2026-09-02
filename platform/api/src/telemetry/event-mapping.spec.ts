import { describe, expect, it } from 'vitest';
import { TELEMETRY_EVENT_TYPES, type TelemetryEvent } from '@lengentic/shared';
import {
  entityKindOf,
  isMergeableEvent,
  toMergeEvent,
  type MergeableTelemetryEvent,
} from './event-mapping';

function runStarted(overrides: Partial<TelemetryEvent> = {}): MergeableTelemetryEvent {
  return {
    eventId: 'evt-1',
    schemaVersion: '1',
    type: 'run.started',
    entityId: 'run-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:00:00.000Z',
    payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: { a: 1 } },
    ...overrides,
  } as MergeableTelemetryEvent;
}

function stepCompleted(overrides: Partial<TelemetryEvent> = {}): MergeableTelemetryEvent {
  return {
    eventId: 'evt-2',
    schemaVersion: '1',
    type: 'step.completed',
    entityId: 'step-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:05:00.000Z',
    payload: { status: 'COMPLETED', metadata: { note: 'done' } },
    ...overrides,
  } as MergeableTelemetryEvent;
}

function decisionRecorded(): TelemetryEvent {
  return {
    eventId: 'evt-3',
    schemaVersion: '2',
    type: 'decision.recorded',
    entityId: 'dec-1',
    runId: 'run-1',
    occurredAt: '2026-08-30T10:00:00.000Z',
    payload: {
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      availableOptions: ['a', 'b'],
      selectedOption: 'a',
    },
  };
}

describe('entityKindOf', () => {
  it('routes run.* types to "run"', () => {
    expect(entityKindOf('run.started')).toBe('run');
    expect(entityKindOf('run.completed')).toBe('run');
  });

  it('routes step.* types to "step"', () => {
    expect(entityKindOf('step.started')).toBe('step');
    expect(entityKindOf('step.completed')).toBe('step');
  });

  // The regression this file exists to prevent. `entityKindOf` was
  // `type.startsWith('run.') ? 'run' : 'step'`, which is a correct total function over four
  // members and a silently wrong one over nine: every Phase 4 type answered 'step', so a
  // Decision id would have been locked, loaded and upserted as a Step row with `tsc`,
  // eslint and every existing test green. Asserted per type rather than in a loop so a
  // failure names the type that regressed.
  //
  // ADR 0014 (p4.entity-ingest): all five now answer their own table, not null — the
  // regression this asserts against today is the OPPOSITE of the one above: a Decision
  // routed into 'step', not left unrouted.
  it('routes both Decision event types to "decision", and the other three Phase 4 types to their own table', () => {
    expect(entityKindOf('decision.recorded')).toBe('decision');
    expect(entityKindOf('decision.outcome_attested')).toBe('decision');
    expect(entityKindOf('model_call.recorded')).toBe('model_call');
    expect(entityKindOf('tool_call.recorded')).toBe('tool_call');
    expect(entityKindOf('error.recorded')).toBe('error');
  });

  // `satisfies Readonly<Record<TelemetryEventType, ...>>` already makes a missing member a
  // compile error; this proves the runtime table is total against the wire contract's own
  // list, so a type added to `TELEMETRY_EVENT_TYPES` cannot reach `entityKindOf` and get
  // `undefined` — which would be neither a kind nor the explicit null. `null` stays in the
  // set of legal answers (ADR 0014: a future type may still arrive mapped to `null`, exactly
  // as these five once were), even though no real type answers it today.
  it('has a non-null answer for every type in the wire contract', () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      expect(['run', 'step', 'decision', 'model_call', 'tool_call', 'error', null]).toContain(
        entityKindOf(type),
      );
      expect(entityKindOf(type)).not.toBeNull();
    }
  });
});

describe('isMergeableEvent', () => {
  it('accepts the four Run/Step lifecycle events', () => {
    expect(isMergeableEvent(runStarted())).toBe(true);
    expect(isMergeableEvent(stepCompleted())).toBe(true);
  });

  // Not the same claim as "has no persistence" any more (ADR 0014 gave it one) — this is
  // purely about the merge FOLD, which still understands only Run/Step lifecycle state.
  it('rejects a Phase 4 event — it is not part of the merge fold, even though it is storable', () => {
    expect(isMergeableEvent(decisionRecorded())).toBe(false);
  });

  it('agrees with entityKindOf for every type in the wire contract', () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      const event = { ...runStarted(), type } as TelemetryEvent;
      const kind = entityKindOf(type);
      expect(isMergeableEvent(event)).toBe(kind === 'run' || kind === 'step');
    }
  });
});

describe('toMergeEvent', () => {
  it('maps a *.started event to kind "start" with the whole payload as fields', () => {
    const merged = toMergeEvent(runStarted(), 1_000);

    expect(merged.kind).toBe('start');
    expect(merged.status).toBeUndefined();
    expect(merged.fields).toEqual({
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      metadata: { a: 1 },
    });
    expect(merged.receivedAt).toBe(1_000);
    expect(merged.eventId).toBe('evt-1');
    expect(merged.entityId).toBe('run-1');
    expect(merged.occurredAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('maps a *.completed event to kind "completion", splitting status out of fields', () => {
    const merged = toMergeEvent(stepCompleted(), 2_000);

    expect(merged.kind).toBe('completion');
    expect(merged.status).toBe('COMPLETED');
    expect(merged.fields).toEqual({ metadata: { note: 'done' } });
    expect(merged.fields).not.toHaveProperty('status');
  });

  it('does not alias the original event payload object into MergeEvent.fields', () => {
    const original = runStarted();
    const merged = toMergeEvent(original, 1_000);

    (original.payload as { workflowName: string }).workflowName = 'mutated';

    // toMergeEvent spreads the payload into a new object; merge-rules.ts itself performs the
    // deep clone, so this only proves toMergeEvent doesn't hand out the same top-level object.
    expect(merged.fields).not.toBe(original.payload);
  });
});
