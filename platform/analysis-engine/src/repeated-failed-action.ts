import type { RepeatedFailedAction, ToolCallRecord } from './tool-call';

/**
 * Repeated failed action analyzer (MVP_PLAN_V3.md §20.2).
 *
 * Generic repeated-sequence and arbitrary loop detection are OUT OF SCOPE — that is a
 * research problem and its false-positive rate is what kills a recommendations product. This
 * analyzer emits only when every one of §20.2's conditions holds:
 *
 *   - Same runId
 *   - Same toolName
 *   - Same sanitized inputFingerprint
 *   - Result is FAILED or records an Error
 *   - At least three CONSECUTIVE attempts, consecutive WITHIN that subsequence
 *   - No successful attempt between them
 *
 * Pure function, no I/O, no clock — `occurredAt` is caller-supplied and only its ordering is
 * used.
 *
 * TWO CONDITIONS HAVE NO FIXTURE BEHIND THEM (`.artifacts/evidence/5a/q1-comparator-adversarial.md`),
 * and both are implemented anyway because the 5b gate checks them even though R1-R5 cannot:
 *
 *   1. The FAILED-or-Error disjunction (`isFailedAttempt` below) — every R fixture expresses
 *      failure through `outcome` alone, so an implementation that ignores `errorType` passes
 *      all five with half the condition unimplemented.
 *   2. `runId` is part of the streak key, not just `toolName` + `inputFingerprint` — every R
 *      fixture has exactly one run, so an implementation keyed on the pair alone also passes
 *      all five, and would still produce the cross-run false positive §20.2's opening
 *      paragraph warns against.
 */

/** §20.2's floor. Below this many consecutive failed attempts, nothing is emitted. */
const MIN_CONSECUTIVE_FAILURES = 3;

/**
 * §20.2's failure condition: `outcome === 'FAILED'` OR `errorType !== null`. Reading
 * `outcome` alone misses an errored call that reported success (`src/tool-call.ts:16-18`).
 */
function isFailedAttempt(call: ToolCallRecord): boolean {
  return call.outcome === 'FAILED' || call.errorType !== null;
}

/** The streak key: `runId` + `toolName` + `inputFingerprint`, all three. Dropping `runId`
 *  lets three failures scattered across unrelated runs satisfy every other condition and
 *  emit — exactly the cross-run false positive §20.2 exists to prevent. */
function streakKey(call: ToolCallRecord): string {
  return JSON.stringify([call.runId, call.toolName, call.inputFingerprint]);
}

/**
 * Detect every repeated-failed-action streak in `calls`.
 *
 * Calls are bucketed by the streak key first, so "consecutive" is evaluated WITHIN each
 * `(runId, toolName, inputFingerprint)` subsequence rather than across the run's whole
 * timeline — an unrelated tool's success (or any other key's calls) falling between two
 * attempts of the streak does not interrupt it, because it never belongs to the subsequence
 * in the first place. `R5` is the fixture that binds this reading.
 *
 * Within a bucket, calls are ordered by `occurredAt` and walked once: a run of
 * `MIN_CONSECUTIVE_FAILURES` or more consecutive failed attempts, broken only by a
 * successful attempt of the SAME key, emits one finding carrying every attempt in the run in
 * order — the evidence, never summarized down to the first three.
 */
export function detectRepeatedFailedActions(
  calls: readonly ToolCallRecord[],
): readonly RepeatedFailedAction[] {
  const buckets = new Map<string, ToolCallRecord[]>();
  for (const call of calls) {
    const key = streakKey(call);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [call]);
    else bucket.push(call);
  }

  const emissions: RepeatedFailedAction[] = [];
  for (const bucket of buckets.values()) {
    const ordered = [...bucket].sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
    );
    emissions.push(...streaksIn(ordered));
  }
  return emissions;
}

/** One key's calls, already ordered by `occurredAt`. Every maximal run of failed attempts
 *  of length >= `MIN_CONSECUTIVE_FAILURES` becomes one emission; a successful attempt ends
 *  the run it interrupts without starting a new one. */
function streaksIn(ordered: readonly ToolCallRecord[]): readonly RepeatedFailedAction[] {
  const found: RepeatedFailedAction[] = [];
  let streak: ToolCallRecord[] = [];

  const flush = (): void => {
    if (streak.length >= MIN_CONSECUTIVE_FAILURES) {
      const first = streak[0];
      if (first !== undefined) {
        found.push({
          runId: first.runId,
          toolName: first.toolName,
          inputFingerprint: first.inputFingerprint,
          attemptCount: streak.length,
          toolCallIds: streak.map((call) => call.toolCallId),
        });
      }
    }
    streak = [];
  };

  for (const call of ordered) {
    if (isFailedAttempt(call)) streak.push(call);
    else flush();
  }
  flush();

  return found;
}
