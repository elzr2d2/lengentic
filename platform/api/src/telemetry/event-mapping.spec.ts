import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '@lengentic/shared';
import { entityKindOf, toMergeEvent } from './event-mapping';

function runStarted(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventId: 'evt-1',
    schemaVersion: '1',
    type: 'run.started',
    entityId: 'run-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:00:00.000Z',
    payload: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: { a: 1 } },
    ...overrides,
  } as TelemetryEvent;
}

function stepCompleted(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventId: 'evt-2',
    schemaVersion: '1',
    type: 'step.completed',
    entityId: 'step-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:05:00.000Z',
    payload: { status: 'COMPLETED', metadata: { note: 'done' } },
    ...overrides,
  } as TelemetryEvent;
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
