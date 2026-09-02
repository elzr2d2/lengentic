import { describe, expect, it, vi } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { ErrorService } from './error.service';
import type { ErrorRecordWrite } from './error-record';
import type { ErrorRepository } from './error.repository';

function fakeRepository(): {
  repository: ErrorRepository;
  record: ReturnType<typeof vi.fn<(input: ErrorRecordWrite) => Promise<void>>>;
} {
  const record = vi.fn<(input: ErrorRecordWrite) => Promise<void>>(() => Promise.resolve());
  return { repository: { record } as unknown as ErrorRepository, record };
}

function errorEvent(): TelemetryEventOf<'error.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'error.recorded',
    entityId: 'err-1',
    runId: 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: { stepId: 'step-1', type: 'TimeoutError', message: 'timed out' },
  };
}

describe('ErrorService.record', () => {
  it('hands the mapped write straight to the repository', async () => {
    const { repository, record } = fakeRepository();

    await new ErrorService(repository).record(errorEvent());

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ id: 'err-1', type: 'TimeoutError' });
  });

  it('propagates a persistence failure rather than reporting an error it did not store', async () => {
    const { repository, record } = fakeRepository();
    record.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(new ErrorService(repository).record(errorEvent())).rejects.toThrow(
      'connection terminated',
    );
  });
});
