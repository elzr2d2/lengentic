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

  it('accepts run.started with metadata key omitted entirely (S5)', () => {
    // .artifacts/evidence/2/wire-contract-recovery.md S5: metadata was required-but-
    // nullable, rejecting an SDK that omits the key. Now .nullish().
    const { metadata: _metadata, ...payloadWithoutMetadata } = {
      workflowName: 'wf',
      workflowVersion: 'v1',
      metadata: null as unknown,
    };
    const result = parseTelemetryEvent({
      eventId: 'evt-9',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: payloadWithoutMetadata,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.payload).not.toHaveProperty('metadata');
  });

  it('accepts run.started with metadata explicitly null (S5)', () => {
    const result = parseTelemetryEvent({
      eventId: 'evt-10',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: { workflowName: 'wf', workflowVersion: 'v1', metadata: null },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'run.started') {
      expect(result.event.payload.metadata).toBeNull();
    }
  });

  it('accepts step.started with metadata key omitted entirely (S5)', () => {
    const result = parseTelemetryEvent({
      eventId: 'evt-11',
      schemaVersion: '1',
      type: 'step.started',
      entityId: 'step-2',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: {
        name: 'do-thing',
        agentName: 'agent-1',
        type: 'tool',
        parentStepId: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts run.started where entityId !== runId — §12/§13 name no such rule (S4)', () => {
    // .artifacts/evidence/2/wire-contract-recovery.md S4: this check was invented in
    // 195af11 with no citation in §12 or §13. Dropped per CLAUDE.md ("do not redesign
    // the approved plan while implementing it"); the Coordinator was asked to file a
    // backlog entry for an eventId/entityId/runId consistency rule if one is wanted.
    const result = parseTelemetryEvent({
      eventId: 'evt-7',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'not-the-run-id',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: { workflowName: 'wf', workflowVersion: 'v1', metadata: null },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts step.started where parentStepId === entityId (self-parent) — no §12/§13 citation (S4)', () => {
    // Same S4 finding: no citation found for rejecting a self-parented step either.
    const result = parseTelemetryEvent({
      eventId: 'evt-8',
      schemaVersion: '1',
      type: 'step.started',
      entityId: 'step-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00Z',
      payload: {
        name: 'do-thing',
        agentName: 'agent-1',
        type: 'tool',
        parentStepId: 'step-1',
        metadata: null,
      },
    });
    expect(result.ok).toBe(true);
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
