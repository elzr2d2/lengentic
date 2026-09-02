import { describe, expect, it } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toErrorRecordWrite } from './error-record';

function errorEvent(
  overrides: Partial<TelemetryEventOf<'error.recorded'>['payload']> = {},
): TelemetryEventOf<'error.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'error.recorded',
    entityId: 'err-1',
    runId: 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: { stepId: 'step-1', type: 'TimeoutError', message: 'timed out', ...overrides },
  };
}

describe('toErrorRecordWrite', () => {
  it('keys the write on the envelope entityId', () => {
    const event = errorEvent();
    event.entityId = 'err-42';

    expect(toErrorRecordWrite(event).id).toBe('err-42');
  });

  it('carries type and message across verbatim', () => {
    const write = toErrorRecordWrite(
      errorEvent({ type: 'ToolTimeout', message: 'charge_card did not answer within 30s' }),
    );

    expect(write.type).toBe('ToolTimeout');
    expect(write.message).toBe('charge_card did not answer within 30s');
  });

  it('does not reject an empty message — uninformative is not malformed', () => {
    const write = toErrorRecordWrite(errorEvent({ message: '' }));

    expect(write.message).toBe('');
  });

  it('defaults an absent metadata to null', () => {
    expect(toErrorRecordWrite(errorEvent()).metadata).toBeNull();
  });
});
