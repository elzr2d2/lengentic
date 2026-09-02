import { describe, expect, it } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toModelCallWrite } from './model-call-record';

function modelCallEvent(
  overrides: Partial<TelemetryEventOf<'model_call.recorded'>['payload']> = {},
): TelemetryEventOf<'model_call.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'model_call.recorded',
    entityId: 'mc-1',
    runId: 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: {
      stepId: 'step-1',
      provider: 'anthropic',
      model: 'claude-opus-5',
      latencyMs: 812,
      status: 'ok',
      ...overrides,
    },
  };
}

describe('toModelCallWrite', () => {
  it('keys the write on the envelope entityId', () => {
    const event = modelCallEvent();
    event.entityId = 'mc-42';

    expect(toModelCallWrite(event).id).toBe('mc-42');
  });

  it('carries the required fields across verbatim', () => {
    const write = toModelCallWrite(modelCallEvent({ provider: 'openai', model: 'gpt' }));

    expect(write.provider).toBe('openai');
    expect(write.model).toBe('gpt');
    expect(write.latencyMs).toBe(812);
    expect(write.status).toBe('ok');
  });

  it('defaults absent inputTokens/outputTokens/metadata to null, never 0', () => {
    const write = toModelCallWrite(modelCallEvent());

    expect(write.inputTokens).toBeNull();
    expect(write.outputTokens).toBeNull();
    expect(write.metadata).toBeNull();
  });

  it('carries reported token counts through, zero included', () => {
    const write = toModelCallWrite(modelCallEvent({ inputTokens: 0, outputTokens: 340 }));

    expect(write.inputTokens).toBe(0);
    expect(write.outputTokens).toBe(340);
  });
});
