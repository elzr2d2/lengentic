import { describe, expect, it } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toDecisionRecordWrite } from './decision-record';

/**
 * Seam: the wire event -> domain translation for §13's recording, called on an envelope
 * rather than through a database — mirrors `decision-attestation.spec.ts`.
 */

function decisionRecordedEvent(
  overrides: Partial<TelemetryEventOf<'decision.recorded'>['payload']> = {},
): TelemetryEventOf<'decision.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'decision.recorded',
    entityId: 'dec-1',
    runId: 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: {
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
      ...overrides,
    },
  };
}

describe('toDecisionRecordWrite', () => {
  it('keys the write on the envelope entityId, which is the decision id', () => {
    const event = decisionRecordedEvent();
    event.entityId = 'dec-42';

    expect(toDecisionRecordWrite(event).decisionId).toBe('dec-42');
  });

  it('takes runId from the envelope', () => {
    const event = decisionRecordedEvent();
    event.runId = 'run-from-elsewhere';

    expect(toDecisionRecordWrite(event).runId).toBe('run-from-elsewhere');
  });

  it('carries the required payload fields across verbatim', () => {
    const write = toDecisionRecordWrite(
      decisionRecordedEvent({
        stepId: 'step-9',
        decisionType: 'retry_policy',
        availableOptions: ['once', 'twice'],
        selectedOption: 'twice',
      }),
    );

    expect(write.stepId).toBe('step-9');
    expect(write.decisionType).toBe('retry_policy');
    expect(write.availableOptions).toStrictEqual(['once', 'twice']);
    expect(write.selectedOption).toBe('twice');
  });

  it('defaults an absent contextKey/contextKeyVersion/rawContext to null, not undefined', () => {
    const write = toDecisionRecordWrite(decisionRecordedEvent());

    expect(write.contextKey).toBeNull();
    expect(write.contextKeyVersion).toBeNull();
    expect(write.rawContext).toBeNull();
  });

  it('carries contextKey/contextKeyVersion/rawContext through when the caller supplied them', () => {
    const write = toDecisionRecordWrite(
      decisionRecordedEvent({
        contextKey: 'risk=low',
        contextKeyVersion: 'v1',
        rawContext: { riskBucket: 'low' },
      }),
    );

    expect(write.contextKey).toBe('risk=low');
    expect(write.contextKeyVersion).toBe('v1');
    expect(write.rawContext).toStrictEqual({ riskBucket: 'low' });
  });
});
