/**
 * Repeated-failed-action input and output types (§20.2). The analyzer graduates in wave 3
 * (`p5.repeated-failed`); this file only fixes the vocabulary it will be built against.
 */

export type ToolCallOutcome = 'SUCCESS' | 'FAILED';

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly runId: string;
  readonly toolName: string;
  /** Stable hash over sanitized, canonicalized input (§15, §20.2). Caller-owned.
   *  The engine never sees raw tool input or output — only this. */
  readonly inputFingerprint: string;
  readonly outcome: ToolCallOutcome;
  /** Non-null means the call recorded an Error. §20.2 counts an attempt as failed when
   *  `outcome === 'FAILED'` OR `errorType !== null` — the disjunction is the condition,
   *  and reading `outcome` alone misses an errored call that reported success. */
  readonly errorType: string | null;
  /** Client clock, ISO-8601 (§12 occurredAt). Orders attempts. */
  readonly occurredAt: string;
}

/** One emission from the §20.2 analyzer. Not the §21 persisted entity — no fingerprint,
 *  no status, no firstSeenAt; those belong to 5b, on the far side of the boundary. */
export interface RepeatedFailedAction {
  readonly runId: string;
  readonly toolName: string;
  readonly inputFingerprint: string;
  /** Length of the failing streak. >= 3 by §20.2. */
  readonly attemptCount: number;
  /** The failing attempts in order — the evidence, never summarized. */
  readonly toolCallIds: readonly string[];
}
