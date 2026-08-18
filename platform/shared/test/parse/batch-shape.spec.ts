import { describe, expect, it } from 'vitest';

import { IngestRequestSchema } from '../../index';

const validEvent = {
  eventId: 'evt-1',
  schemaVersion: '1',
  type: 'run.started',
  entityId: 'run-1',
  runId: 'run-1',
  occurredAt: '2026-08-18T10:00:00Z',
  payload: { workflowName: 'wf', workflowVersion: 'v1', metadata: null },
};

describe('IngestRequestSchema — request-level (batch) shape only', () => {
  it('rejects a missing events field', () => {
    const result = IngestRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty events array', () => {
    const result = IngestRequestSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it('rejects 501 events (over the 500 cap)', () => {
    const events = Array.from({ length: 501 }, () => validEvent);
    const result = IngestRequestSchema.safeParse({ events });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 500 events', () => {
    const events = Array.from({ length: 500 }, () => validEvent);
    const result = IngestRequestSchema.safeParse({ events });
    expect(result.success).toBe(true);
  });

  it('accepts a batch where one event is garbage — the whole batch is not rejected', () => {
    // §12: "A malformed event never rejects the whole batch." IngestRequestSchema
    // validates batch shape only; a bad event surfaces as its own REJECTED result via
    // parseTelemetryEvent, downstream of this schema, never here.
    const events = [validEvent, validEvent, validEvent, 'garbage', validEvent];
    const result = IngestRequestSchema.safeParse({ events });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(5);
    }
  });
});
