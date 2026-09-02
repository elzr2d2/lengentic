import { describe, expect, it, vi } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { ModelCallService } from './model-call.service';
import type { ModelCallWrite } from './model-call-record';
import type { ModelCallRepository } from './model-call.repository';

function fakeRepository(): {
  repository: ModelCallRepository;
  record: ReturnType<typeof vi.fn<(input: ModelCallWrite) => Promise<void>>>;
} {
  const record = vi.fn<(input: ModelCallWrite) => Promise<void>>(() => Promise.resolve());
  return { repository: { record } as unknown as ModelCallRepository, record };
}

function modelCallEvent(): TelemetryEventOf<'model_call.recorded'> {
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
    },
  };
}

describe('ModelCallService.record', () => {
  it('hands the mapped write straight to the repository', async () => {
    const { repository, record } = fakeRepository();

    await new ModelCallService(repository).record(modelCallEvent());

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ id: 'mc-1', provider: 'anthropic' });
  });

  it('propagates a persistence failure rather than reporting a call it did not store', async () => {
    const { repository, record } = fakeRepository();
    record.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(new ModelCallService(repository).record(modelCallEvent())).rejects.toThrow(
      'connection terminated',
    );
  });
});
