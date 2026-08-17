/**
 * Gate vocabulary (MVP_PLAN_V3.md §19). Declarations only — never a function.
 *
 * This file holds `GateId`, `GateStatus`, `Verdict`, `GateResult`, `GateEvaluation` and
 * `GATE_IDS`, permanently. Wave 3 creates a NEW `src/gates.ts` for the gate functions,
 * importing this vocabulary. The split makes "no gate logic in wave 1" checkable by file
 * existence instead of by reading a diff: `src/gates.ts` must NOT exist at the end of wave 1.
 */

export type GateId =
  | 'G1_sample_count'
  | 'G2_context_diversity'
  | 'G3_dominance'
  | 'G4_outcome_success'
  | 'G5_outcome_coverage';

export type GateStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export type Verdict = 'CANDIDATE' | 'SUPPRESSED';

/** Report order, G1..G5. Every evaluation carries one result per entry, in this order. */
export const GATE_IDS: readonly GateId[] = Object.freeze([
  'G1_sample_count',
  'G2_context_diversity',
  'G3_dominance',
  'G4_outcome_success',
  'G5_outcome_coverage',
]);

export interface GateResult {
  readonly id: GateId;
  readonly status: GateStatus;
  /** Human-readable comparison, e.g. "12 >= 5". Evidence for a reader, never an
   *  assertion target — formatting is not part of this contract. */
  readonly comparison: string;
}

export interface GateEvaluation {
  /** One per GATE_IDS entry, in GATE_IDS order. */
  readonly gates: readonly GateResult[];
  /** Exactly the ids whose status is 'FAIL'. A 'NOT_APPLICABLE' gate NEVER appears here. */
  readonly failedGates: readonly GateId[];
  /** 'CANDIDATE' iff every status is 'PASS'. 'NOT_APPLICABLE' is not 'PASS'. */
  readonly verdict: Verdict;
}
