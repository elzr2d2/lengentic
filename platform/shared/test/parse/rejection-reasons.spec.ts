import { describe, expect, it } from 'vitest';

import { parseTelemetryEvent } from '../../index';

const VALID_RUN_STARTED = {
  eventId: 'evt-1',
  schemaVersion: '1',
  type: 'run.started',
  entityId: 'run-1',
  runId: 'run-1',
  occurredAt: '2026-08-18T10:00:00Z',
  payload: {
    workflowName: 'wf',
    workflowVersion: 'v1',
    metadata: null,
  },
};

// §12 bullets, in bullet order:
//   1. unknown or missing schemaVersion                      -> UNSUPPORTED_SCHEMA_VERSION
//   2. unknown type                                           -> UNKNOWN_EVENT_TYPE
//   3. missing eventId / entityId / runId / occurredAt        -> MISSING_REQUIRED_FIELD
//   4. payload fails its Zod schema                           -> INVALID_PAYLOAD

describe('parseTelemetryEvent — UNSUPPORTED_SCHEMA_VERSION', () => {
  it('rejects a missing schemaVersion', () => {
    const { schemaVersion: _schemaVersion, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects schemaVersion "2"', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, schemaVersion: '2' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects schemaVersion as a number, not a string', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });
});

describe('parseTelemetryEvent — UNKNOWN_EVENT_TYPE', () => {
  it('rejects a typo\'d type ("run.complete")', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, type: 'run.complete' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it('rejects a real Phase-4 type this version does not know ("decision.recorded")', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, type: 'decision.recorded' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it('rejects the rejected naming convention ("RUN_STARTED")', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, type: 'RUN_STARTED' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_EVENT_TYPE');
  });
});

describe('parseTelemetryEvent — MISSING_REQUIRED_FIELD', () => {
  it('rejects a missing eventId', () => {
    const { eventId: _eventId, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects a missing entityId', () => {
    const { entityId: _entityId, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects a missing runId', () => {
    const { runId: _runId, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects a missing occurredAt', () => {
    const { occurredAt: _occurredAt, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects occurredAt with no time component', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, occurredAt: '2026-08-18' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects occurredAt with no timezone offset', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      occurredAt: '2026-08-18T10:00:00',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects an empty-string eventId', () => {
    const result = parseTelemetryEvent({ ...VALID_RUN_STARTED, eventId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects a string input (not a JSON object)', () => {
    const result = parseTelemetryEvent('garbage');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_FIELD');
      expect(result.eventId).toBeNull();
    }
  });

  it('rejects a null input', () => {
    const result = parseTelemetryEvent(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects an array input', () => {
    const result = parseTelemetryEvent([VALID_RUN_STARTED]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_FIELD');
  });
});

describe('parseTelemetryEvent — INVALID_PAYLOAD', () => {
  it('rejects run.started without workflowVersion', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      payload: { workflowName: 'wf', metadata: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects run.completed with status "RUNNING" (server-assigned, never sent)', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      type: 'run.completed',
      payload: { status: 'RUNNING', metadata: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects step.completed with status "DONE" (not a terminal status)', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      type: 'step.completed',
      entityId: 'step-1',
      payload: { status: 'DONE', metadata: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects run.started where entityId !== runId', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      entityId: 'not-the-run-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects step.started where parentStepId === entityId (self-parent)', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      type: 'step.started',
      entityId: 'step-1',
      payload: {
        name: 'do-thing',
        agentName: 'agent-1',
        type: 'tool',
        parentStepId: 'step-1',
        metadata: null,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects a missing payload', () => {
    const { payload: _payload, ...rest } = VALID_RUN_STARTED;
    const result = parseTelemetryEvent(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });
});

describe('parseTelemetryEvent — bullet ordering', () => {
  it('reports UNSUPPORTED_SCHEMA_VERSION when both schemaVersion and type are wrong', () => {
    const result = parseTelemetryEvent({
      ...VALID_RUN_STARTED,
      schemaVersion: '2',
      type: 'not.a.real.type',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });
});
