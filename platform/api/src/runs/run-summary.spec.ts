import { describe, expect, it } from 'vitest';
import {
  aggregateRunSummary,
  type ModelCallMetrics,
  type RunSummary,
  type ToolCallMetrics,
} from './run-summary';

/**
 * Seam: `aggregateRunSummary`, the whole of §23's arithmetic, observed through its return
 * value. It is pure, so every case here is the real function over real inputs — there is
 * nothing to fake and nothing to stub.
 *
 * The expected values are written out as literals computed by hand, not by re-summing the
 * fixture in the test. A test that computed `calls.reduce((n, c) => n + c.latencyMs, 0)`
 * would agree with any implementation that reduced the same way, including a wrong one.
 */
function modelCall(overrides: Partial<ModelCallMetrics> = {}): ModelCallMetrics {
  return { latencyMs: 100, inputTokens: 10, outputTokens: 5, ...overrides };
}

function toolCall(success: boolean): ToolCallMetrics {
  return { success };
}

const EMPTY: RunSummary = {
  runId: 'run-1',
  modelCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelCallsMissingInputTokens: 0,
  modelCallsMissingOutputTokens: 0,
  totalModelLatencyMs: 0,
  toolCallCount: 0,
  failedToolCallCount: 0,
  droppedTelemetryEventCount: null,
};

describe('aggregateRunSummary', () => {
  it('reports every §23 field over one run of mixed telemetry', () => {
    // One whole-object assertion rather than eight field assertions: a field that stopped
    // being emitted at all would satisfy every `toBe` written about the others.
    //
    // Hand-computed. Model calls: 3 → latency 120 + 45 + 900 = 1065; input 30 + 12 = 42 with
    // one null; output 7 + 60 + 3 = 70 with none null. Tool calls: 4, of which 2 failed.
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [
        modelCall({ latencyMs: 120, inputTokens: 30, outputTokens: 7 }),
        modelCall({ latencyMs: 45, inputTokens: null, outputTokens: 60 }),
        modelCall({ latencyMs: 900, inputTokens: 12, outputTokens: 3 }),
      ],
      toolCalls: [toolCall(true), toolCall(false), toolCall(true), toolCall(false)],
      droppedTelemetryEventCount: null,
    });

    expect(summary).toStrictEqual({
      runId: 'run-1',
      modelCallCount: 3,
      inputTokens: 42,
      outputTokens: 70,
      modelCallsMissingInputTokens: 1,
      modelCallsMissingOutputTokens: 0,
      totalModelLatencyMs: 1065,
      toolCallCount: 4,
      failedToolCallCount: 2,
      droppedTelemetryEventCount: null,
    } satisfies RunSummary);
  });

  it('reports a run with no model or tool calls as zeroes, not as absent fields', () => {
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [],
      droppedTelemetryEventCount: null,
    });

    expect(summary).toStrictEqual(EMPTY);
  });

  it('separates a reported zero token count from an unreported one', () => {
    // The case the whole `modelCallsMissing*` pair exists for. Both calls add nothing to the
    // total; only one of them means "this provider told us nothing". An implementation that
    // coalesced null to 0 produces identical token totals here and is caught by the counts.
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [
        modelCall({ latencyMs: 1, inputTokens: 0, outputTokens: 0 }),
        modelCall({ latencyMs: 1, inputTokens: null, outputTokens: null }),
      ],
      toolCalls: [],
      droppedTelemetryEventCount: null,
    });

    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.modelCallsMissingInputTokens).toBe(1);
    expect(summary.modelCallsMissingOutputTokens).toBe(1);
    expect(summary.modelCallCount).toBe(2);
  });

  it('counts a missing input token count without disturbing the output total', () => {
    // The two token fields are independent: §13 marks each optional on its own, and a
    // provider that reports output usage but not input is an ordinary shape, not a broken
    // row. An implementation that skipped the whole call on the first null would report
    // outputTokens: 0 here.
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [modelCall({ inputTokens: null, outputTokens: 99 })],
      toolCalls: [],
      droppedTelemetryEventCount: null,
    });

    expect(summary.outputTokens).toBe(99);
    expect(summary.modelCallsMissingInputTokens).toBe(1);
    expect(summary.modelCallsMissingOutputTokens).toBe(0);
  });

  it('totals model latency rather than averaging it', () => {
    // 250 + 250 = 500. An average, a max and a first-value implementation all return 250.
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [modelCall({ latencyMs: 250 }), modelCall({ latencyMs: 250 })],
      toolCalls: [],
      droppedTelemetryEventCount: null,
    });

    expect(summary.totalModelLatencyMs).toBe(500);
  });

  it('counts every tool call, and only the unsuccessful ones as failed', () => {
    const allGood = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [toolCall(true), toolCall(true), toolCall(true)],
      droppedTelemetryEventCount: null,
    });
    const allBad = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [toolCall(false), toolCall(false), toolCall(false)],
      droppedTelemetryEventCount: null,
    });

    // Both directions in one case: an implementation that never counts a failure and one
    // that counts every call as a failure each satisfy exactly half of this.
    expect([allGood.toolCallCount, allGood.failedToolCallCount]).toStrictEqual([3, 0]);
    expect([allBad.toolCallCount, allBad.failedToolCallCount]).toStrictEqual([3, 3]);
  });

  it('reports an unknown dropped-event count as null, never as zero', () => {
    // §23's own reason for reporting drops at all is that a summary over silently truncated
    // data is misleading. `0` asserts "nothing was dropped" from a signal the platform never
    // receives — see the field note in run-summary.ts.
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [modelCall()],
      toolCalls: [toolCall(true)],
      droppedTelemetryEventCount: null,
    });

    expect(summary.droppedTelemetryEventCount).toBeNull();
  });

  it('passes a reported dropped-event count through unchanged, including zero', () => {
    // Pins the field as a carrier rather than a constant: the day a wire field supplies a
    // real count, `0` from that source means "none dropped" and must survive.
    const none = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [],
      droppedTelemetryEventCount: 0,
    });
    const some = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [],
      droppedTelemetryEventCount: 17,
    });

    expect(none.droppedTelemetryEventCount).toBe(0);
    expect(some.droppedTelemetryEventCount).toBe(17);
  });

  it('carries the run id it was given', () => {
    expect(
      aggregateRunSummary('run-other', {
        modelCalls: [],
        toolCalls: [],
        droppedTelemetryEventCount: null,
      }).runId,
    ).toBe('run-other');
  });

  it('does not report repeated failed actions — §20.2 is p5.repeated-failed', () => {
    // §23 lists the line and this packet's contract says to ship the field last, after the
    // analyzer that defines it. Asserted rather than left to a comment, so a well-meaning
    // re-implementation of §20.2 here turns this test red instead of shipping a second,
    // divergent definition of "repeated failed action".
    const summary = aggregateRunSummary('run-1', {
      modelCalls: [],
      toolCalls: [toolCall(false), toolCall(false), toolCall(false)],
      droppedTelemetryEventCount: null,
    });

    expect(summary).not.toHaveProperty('repeatedFailedActions');
  });
});
