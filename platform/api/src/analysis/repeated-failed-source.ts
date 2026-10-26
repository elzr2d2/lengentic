import { detectRepeatedFailedActions, type ToolCallRecord } from '@lengentic/analysis-engine';
import type {
  RepeatedFailedActionCounterexample,
  RepeatedFailedActionEvidence,
  RepeatedFailedActionKey,
} from '@lengentic/shared';

/**
 * One persisted `ToolCall`, on the API's side of the persistence edge, reduced to the columns
 * §20.2 reads. `input` and `output` are absent on purpose: the analyzer's contract is that it
 * "never sees raw tool input or output — only" the fingerprint (`analysis-engine/src/
 * tool-call.ts`), and a projection that never loaded them cannot leak them.
 */
export interface AnalysisToolCallSource {
  readonly toolCallId: string;
  readonly runId: string;
  readonly toolName: string;
  /** `null` for a ToolCall whose SDK sent no fingerprint — it cannot join any streak. */
  readonly inputFingerprint: string | null;
  readonly success: boolean;
  readonly error: string | null;
  /** Client clock (§13). Orders attempts. */
  readonly startedAt: Date;
}

/**
 * The §20.2 condition mapped from persisted columns: an attempt FAILED when the caller
 * attested `success: false`, and "records an Error" when `error` is non-null. The engine
 * counts either as failed (`outcome === 'FAILED' || errorType !== null`), and a persisted
 * ToolCall carries only the message, so the type is the fixed marker `ToolCallError`.
 */
const TOOL_CALL_ERROR_TYPE = 'ToolCallError';

/**
 * A ToolCall with no fingerprint is dropped, not given a placeholder: a shared placeholder
 * would make every fingerprint-less call of one tool in one run "the same input", which is
 * exactly the false positive §20.2's opening paragraph exists to prevent. Absent means
 * unknown, and unknown is not equal to anything.
 */
export function toEngineToolCallRecords(
  sources: readonly AnalysisToolCallSource[],
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];

  for (const source of sources) {
    if (source.inputFingerprint === null) continue;

    records.push({
      toolCallId: source.toolCallId,
      runId: source.runId,
      toolName: source.toolName,
      inputFingerprint: source.inputFingerprint,
      outcome: source.success ? 'SUCCESS' : 'FAILED',
      errorType: source.error === null ? null : TOOL_CALL_ERROR_TYPE,
      occurredAt: source.startedAt.toISOString(),
    });
  }

  return records;
}

/** What one analysis run asserts about one streak key, before it is persisted. */
export interface RepeatedFailedActionFinding {
  readonly actionKey: RepeatedFailedActionKey;
  readonly evidence: RepeatedFailedActionEvidence;
  readonly counterexamples: readonly RepeatedFailedActionCounterexample[];
}

const keyOf = (key: RepeatedFailedActionKey): string =>
  JSON.stringify([key.runId, key.toolName, key.inputFingerprint]);

/**
 * Detect, then fold to ONE finding per `(runId, toolName, inputFingerprint)`.
 *
 * The engine emits one finding per maximal streak, so F F F S F F F is two. The recommendation
 * fingerprint is the key (`fingerprint.ts` — identity, not evidence), so two streaks of one
 * key are one row; the longer is kept (the earlier on a tie) and the other is not lost
 * silently — the success that separated them is a counterexample on the row.
 *
 * Counterexamples are the SUCCESS attempts of the same key, in attempt order: evidence that
 * the tool works on this input, shown beside the claim that it repeatedly failed.
 */
export function findRepeatedFailedActions(
  records: readonly ToolCallRecord[],
): RepeatedFailedActionFinding[] {
  const longest = new Map<string, RepeatedFailedActionFinding>();

  for (const streak of detectRepeatedFailedActions(records)) {
    const actionKey: RepeatedFailedActionKey = {
      runId: streak.runId,
      toolName: streak.toolName,
      inputFingerprint: streak.inputFingerprint,
    };
    const key = keyOf(actionKey);
    const kept = longest.get(key);

    if (kept === undefined || streak.attemptCount > kept.evidence.attemptCount) {
      longest.set(key, {
        actionKey,
        evidence: {
          attemptCount: streak.attemptCount,
          toolCallIds: [...streak.toolCallIds],
        },
        counterexamples: [],
      });
    }
  }

  const successes = new Map<string, ToolCallRecord[]>();
  for (const record of records) {
    const isSuccess = record.outcome === 'SUCCESS' && record.errorType === null;
    if (!isSuccess) continue;

    const key = keyOf(record);
    if (!longest.has(key)) continue;

    const bucket = successes.get(key);
    if (bucket === undefined) successes.set(key, [record]);
    else bucket.push(record);
  }

  return [...longest.entries()].map(([key, finding]) => ({
    ...finding,
    counterexamples: (successes.get(key) ?? [])
      .slice()
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
      .map((call) => ({ toolCallId: call.toolCallId, runId: call.runId, outcome: 'SUCCESS' })),
  }));
}
