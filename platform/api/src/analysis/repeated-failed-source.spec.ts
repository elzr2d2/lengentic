import { describe, expect, it } from 'vitest';

import {
  findRepeatedFailedActions,
  toEngineToolCallRecords,
  type AnalysisToolCallSource,
} from './repeated-failed-source';

/**
 * Seam: the persistence-edge mapping from stored ToolCall columns to the engine's
 * `ToolCallRecord`, and the fold from the engine's per-streak emissions to one finding per
 * key. The engine itself is real (not faked) — what is under test is the mapping the engine
 * cannot see. Negative cases first.
 */

function call(n: number, overrides: Partial<AnalysisToolCallSource> = {}): AnalysisToolCallSource {
  return {
    toolCallId: `tc-${String(n)}`,
    runId: 'run-1',
    toolName: 'run_tests',
    inputFingerprint: 'fp-a',
    success: false,
    error: 'boom',
    startedAt: new Date(Date.UTC(2026, 9, 26, 10, n)),
    ...overrides,
  };
}

describe('toEngineToolCallRecords', () => {
  it('drops a call with no fingerprint — a shared placeholder would invent the false positive §20.2 exists to prevent', () => {
    expect(toEngineToolCallRecords([call(1, { inputFingerprint: null })])).toStrictEqual([]);
  });

  it('maps success:false to FAILED and success:true to SUCCESS', () => {
    const [failed, ok] = toEngineToolCallRecords([
      call(1),
      call(2, { success: true, error: null }),
    ]);

    expect(failed?.outcome).toBe('FAILED');
    expect(ok?.outcome).toBe('SUCCESS');
  });

  it('carries a recorded error as errorType — the OR half of the failure condition', () => {
    const [errored, clean] = toEngineToolCallRecords([
      call(1, { success: true, error: 'recorded' }),
      call(2, { success: true, error: null }),
    ]);

    expect(errored?.errorType).not.toBeNull();
    expect(clean?.errorType).toBeNull();
  });

  it('orders by the client clock it was given, as ISO-8601', () => {
    const [record] = toEngineToolCallRecords([call(7)]);

    expect(record?.occurredAt).toBe('2026-10-26T10:07:00.000Z');
  });
});

describe('findRepeatedFailedActions', () => {
  const run = (calls: AnalysisToolCallSource[]) =>
    findRepeatedFailedActions(toEngineToolCallRecords(calls));

  it('emits nothing for two failures', () => {
    expect(run([call(1), call(2)])).toStrictEqual([]);
  });

  it('emits nothing when a success of the same key falls between', () => {
    expect(
      run([call(1), call(2), call(3, { success: true, error: null }), call(4), call(5)]),
    ).toStrictEqual([]);
  });

  it('emits nothing across runs', () => {
    expect(
      run([call(1, { runId: 'r1' }), call(2, { runId: 'r2' }), call(3, { runId: 'r3' })]),
    ).toStrictEqual([]);
  });

  it('emits one finding for three, with the three ids in order and an empty counterexample list', () => {
    const [finding, ...rest] = run([call(1), call(2), call(3)]);

    expect(rest).toStrictEqual([]);
    expect(finding?.actionKey).toStrictEqual({
      runId: 'run-1',
      toolName: 'run_tests',
      inputFingerprint: 'fp-a',
    });
    expect(finding?.evidence).toStrictEqual({
      attemptCount: 3,
      toolCallIds: ['tc-1', 'tc-2', 'tc-3'],
    });
    expect(finding?.counterexamples).toStrictEqual([]);
  });

  it('an unrelated tool succeeding between the attempts does not interrupt the streak (R5)', () => {
    const findings = run([
      call(1),
      call(2, { toolName: 'other', success: true, error: null }),
      call(3),
      call(4),
    ]);

    expect(findings).toHaveLength(1);
  });

  it('keeps the earlier streak on a tie in length', () => {
    const [finding] = run([
      call(1),
      call(2),
      call(3),
      call(4, { success: true, error: null }),
      call(5),
      call(6),
      call(7),
    ]);

    expect(finding?.evidence.toolCallIds).toStrictEqual(['tc-1', 'tc-2', 'tc-3']);
  });

  it('does not list a success of a DIFFERENT key as a counterexample', () => {
    const [finding] = run([
      call(1),
      call(2),
      call(3),
      call(4, { inputFingerprint: 'fp-other', success: true, error: null }),
    ]);

    expect(finding?.counterexamples).toStrictEqual([]);
  });
});
