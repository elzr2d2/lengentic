/**
 * Decision domain types (MVP_PLAN_V3.md §18-19).
 *
 * Graduated from `spike/types.ts` with three amendments, none cosmetic:
 *
 * 1. `attestedSuccessRate` -> `dominantOptionAttestedSuccessRate`. §19 evaluates G4 on the
 *    dominant option specifically; the spike computed it group-wide, which disagrees with
 *    the per-option reading on D1, D3 and D6 (D3 is 43/47 over the YES rows, not 46/50
 *    group-wide).
 * 2. `distinctContextCount` -> `distinctContextKeyCount`, the name §18 and §19 both use.
 * 3. `label` dropped from `GateResult` (see `./gate-contract.ts`) — derivable from `GateId`,
 *    bound by no grid column, and rendering belongs to 5b.
 *
 * Nothing here knows about Postgres, HTTP, or the SDK.
 */

export type Outcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

export type OutcomeAttestedBy = 'CALLER' | 'UNKNOWN';

/**
 * One observed decision. `runIsStale` is the derived STALE flag from MVP_PLAN §39,
 * resolved by the caller before aggregation — the analyzer does not own clock policy.
 */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly runId: string;
  readonly runIsStale: boolean;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly decisionType: string;
  /** Caller-owned normalization (§54). Null means "excluded from aggregation". */
  readonly contextKey: string | null;
  readonly contextKeyVersion: string;
  readonly availableOptions: readonly string[];
  readonly selectedOption: string;
  readonly outcome: Outcome;
  readonly outcomeAttestedBy: OutcomeAttestedBy;
}

/**
 * The corrected group key (§18).
 *
 * `contextKey` is deliberately NOT a member. It is a dimension measured *within* a group.
 * Including it would pin `distinctContextKeyCount` to 1 and make G2 unsatisfiable.
 */
export interface GroupKey {
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly decisionType: string;
  readonly contextKeyVersion: string;
}

export interface ExclusionCounts {
  readonly staleRun: number;
  readonly missingContextKey: number;
}

export interface OptionCount {
  readonly option: string;
  readonly count: number;
  /** Fraction of sampleCount, 0..1. */
  readonly share: number;
}

/**
 * A decision that did NOT select the dominant option. Reported individually and never
 * summarized away — this is the evidence *against* the recommendation (§2, §18).
 */
export interface Counterexample {
  readonly decisionId: string;
  readonly runId: string;
  readonly contextKey: string;
  readonly selectedOption: string;
  readonly outcome: Outcome;
}

/**
 * Where the minority sits (§18). A minority concentrated in one context names the
 * escape-hatch condition; a scattered minority says the boundary is not context-shaped
 * and the branch is doing something `contextKey` fails to capture.
 */
export interface ContextConcentration {
  readonly contextKey: string;
  readonly count: number;
  /** Fraction of the minority, 0..1. */
  readonly share: number;
}

export interface DecisionAggregate {
  readonly key: GroupKey;
  readonly sampleCount: number;
  readonly distinctContextKeyCount: number;
  readonly optionDistribution: readonly OptionCount[];
  readonly dominantOption: string | null;
  /** 0..1. Zero for an empty group. */
  readonly dominancePercentage: number;
  readonly attestedCount: number;
  /** 0..1. Fraction of samples carrying a non-UNKNOWN outcome. */
  readonly outcomeCoverage: number;
  /**
   * 0..1, or `null` when nothing has been attested for the dominant option.
   *
   * Null is not zero. A group with no attested outcomes for its dominant option has an
   * *unknown* success rate, and rendering that as 0.0% would be exactly the kind of
   * authoritative-looking meaningless number §2 forbids. G4 evaluates this field
   * specifically — a blended rate across all options can clear the gate while the option
   * being recommended is the one that fails (§19).
   */
  readonly dominantOptionAttestedSuccessRate: number | null;
  readonly counterexamples: readonly Counterexample[];
  readonly minorityContextConcentration: readonly ContextConcentration[];
  readonly excluded: ExclusionCounts;
}
