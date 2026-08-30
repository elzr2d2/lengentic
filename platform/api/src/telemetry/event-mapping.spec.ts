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
  it('answers null for the Phase 4 types, which have no Run/Step fold', () => {
    expect(entityKindOf('decision.recorded')).toBeNull();
    expect(entityKindOf('decision.outcome_attested')).toBeNull();
    expect(entityKindOf('model_call.recorded')).toBeNull();
    expect(entityKindOf('tool_call.recorded')).toBeNull();
    expect(entityKindOf('error.recorded')).toBeNull();
  });

  // `satisfies Readonly<Record<TelemetryEventType, ...>>` already makes a missing member a
  // compile error; this proves the runtime table is total against the wire contract's own
  // list, so a type added to `TELEMETRY_EVENT_TYPES` cannot reach `entityKindOf` and get
  // `undefined` — which would be neither a kind nor the explicit null.
  it('has an answer for every type in the wire contract', () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      expect([...(['run', 'step'] as const), null]).toContain(entityKindOf(type));
    }
  });
});

describe('isMergeableEvent', () => {
  it('accepts the four Run/Step lifecycle events', () => {
    expect(isMergeableEvent(runStarted())).toBe(true);
    expect(isMergeableEvent(stepCompleted())).toBe(true);
  });

  it('rejects a Phase 4 event', () => {
    expect(isMergeableEvent(decisionRecorded())).toBe(false);
  });

  it('agrees with entityKindOf for every type in the wire contract', () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      const event = { ...runStarted(), type } as TelemetryEvent;
      expect(isMergeableEvent(event)).toBe(entityKindOf(type) !== null);
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
