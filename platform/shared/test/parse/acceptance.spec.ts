import { describe, expect, it } from 'vitest';

import { parseTelemetryEvent } from '../../index';

describe('parseTelemetryEvent — the four happy paths', () => {
  it('accepts a valid run.started event', () => {
    const payload = { workflowName: 'wf', workflowVersion: 'v1', metadata: { a: 1 } };
    const result = parseTelemetryEvent({
      eventId: 'evt-1',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('run.started');
      expect(result.event.payload).toEqual(payload);
    }
  });

  it('accepts a valid run.completed event', () => {
    const payload = { status: 'COMPLETED', metadata: null };
    const result = parseTelemetryEvent({
      eventId: 'evt-2',
      schemaVersion: '1',
      type: 'run.completed',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:05:00Z',
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('run.completed');
      expect(result.event.payload).toEqual(payload);
    }
  });

  it('accepts a valid step.started event', () => {
    const payload = {
      name: 'do-thing',
      agentName: 'agent-1',
      type: 'tool',
      parentStepId: null,
      metadata: null,
    };
    const result = parseTelemetryEvent({
      eventId: 'evt-3',
      schemaVersion: '1',
      type: 'step.started',
      entityId: 'step-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:01:00Z',
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('step.started');
      expect(result.event.payload).toEqual(payload);
    }
  });

  it('accepts a valid step.completed event', () => {
    const payload = { status: 'FAILED', metadata: null };
    const result = parseTelemetryEvent({
      eventId: 'evt-4',
      schemaVersion: '1',
      type: 'step.completed',
      entityId: 'step-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:02:00Z',
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('step.completed');
      expect(result.event.payload).toEqual(payload);
    }
  });

  it('narrows result.event.payload by result.event.type — must compile', () => {
    const result = parseTelemetryEvent({
      eventId: 'evt-5',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: { workflowName: 'wf', workflowVersion: 'v1', metadata: null },
    });
    if (result.ok && result.event.type === 'run.started') {
      expect(result.event.payload.workflowVersion).toBe('v1');
    } else {
      throw new Error('expected an ok run.started result');
    }
  });

  it('strips an unknown extra payload key (z.object, not z.strictObject)', () => {
    const result = parseTelemetryEvent({
      eventId: 'evt-6',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: {
        workflowName: 'wf',
        workflowVersion: 'v1',
        metadata: null,
        futureField: 'from a newer SDK',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.payload).not.toHaveProperty('futureField');
    }
  });
});
