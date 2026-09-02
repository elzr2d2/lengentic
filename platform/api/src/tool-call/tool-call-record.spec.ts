import { describe, expect, it } from 'vitest';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toToolCallWrite } from './tool-call-record';

function toolCallEvent(
  overrides: Partial<TelemetryEventOf<'tool_call.recorded'>['payload']> = {},
): TelemetryEventOf<'tool_call.recorded'> {
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
      ...overrides,
    },
  };
}

describe('toToolCallWrite', () => {
  it('keys the write on the envelope entityId', () => {
    const event = toolCallEvent();
    event.entityId = 'tc-42';

    expect(toToolCallWrite(event).id).toBe('tc-42');
  });

  it('parses startedAt/completedAt into real Date instants', () => {
    const write = toToolCallWrite(toolCallEvent());

    expect(write.startedAt).toStrictEqual(new Date('2026-09-02T10:00:00.000Z'));
    expect(write.completedAt).toStrictEqual(new Date('2026-09-02T10:00:00.250Z'));
  });

  it('defaults absent input/output/error to null, never an empty object or string', () => {
    const write = toToolCallWrite(toolCallEvent());

    expect(write.input).toBeNull();
    expect(write.output).toBeNull();
    expect(write.error).toBeNull();
  });

  it('carries a non-object input/output through — a tool payload is not necessarily JSON', () => {
    const write = toToolCallWrite(toolCallEvent({ input: 'raw string input', output: [1, 2, 3] }));

    expect(write.input).toBe('raw string input');
    expect(write.output).toStrictEqual([1, 2, 3]);
  });

  it('carries the truncation and byte-count flags through verbatim', () => {
    const write = toToolCallWrite(
      toolCallEvent({
        inputTruncated: true,
        outputTruncated: false,
        inputBytes: 32_768,
        outputBytes: 12,
      }),
    );

    expect(write.inputTruncated).toBe(true);
    expect(write.outputTruncated).toBe(false);
    expect(write.inputBytes).toBe(32_768);
    expect(write.outputBytes).toBe(12);
  });
});
