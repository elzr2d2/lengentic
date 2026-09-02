import { describe, expect, it, vi } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { ToolCallService } from './tool-call.service';
import type { ToolCallWrite } from './tool-call-record';
import type { ToolCallRepository } from './tool-call.repository';

function fakeRepository(): {
  repository: ToolCallRepository;
  record: ReturnType<typeof vi.fn<(input: ToolCallWrite) => Promise<void>>>;
} {
  const record = vi.fn<(input: ToolCallWrite) => Promise<void>>(() => Promise.resolve());
  return { repository: { record } as unknown as ToolCallRepository, record };
}

function toolCallEvent(): TelemetryEventOf<'tool_call.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'tool_call.recorded',
    entityId: 'tc-1',
    runId: 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: {
      stepId: 'step-1',
      toolName: 'search',
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 0,
      outputBytes: 0,
      startedAt: '2026-09-02T10:00:00.000Z',
      completedAt: '2026-09-02T10:00:00.250Z',
      durationMs: 250,
      success: true,
    },
  };
}

describe('ToolCallService.record', () => {
  it('hands the mapped write straight to the repository', async () => {
    const { repository, record } = fakeRepository();

    await new ToolCallService(repository).record(toolCallEvent());

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ id: 'tc-1', toolName: 'search' });
  });

  it('propagates a persistence failure rather than reporting a call it did not store', async () => {
    const { repository, record } = fakeRepository();
    record.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(new ToolCallService(repository).record(toolCallEvent())).rejects.toThrow(
      'connection terminated',
    );
  });
});
