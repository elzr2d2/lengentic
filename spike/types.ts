/**
 * Phase 0 domain types.
 *
 * These graduate into `platform/analysis-engine` in Phase 5, so they are written as the
 * analyzer's view of the world, not as a database schema. Nothing here knows about
 * Postgres, HTTP, or the SDK.
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
 * The corrected group key (corrections doc §1).
 *
 * `contextKey` is deliberately NOT a member. It is a dimension measured *within* a group.
 * Including it would pin `distinctContextCount` to 1 and make G2 unsatisfiable.
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
 * summarized away — this is the evidence *against* the recommendation (§2, §73).
 */
export interface Counterexample {
  readonly decisionId: string;
  readonly runId: string;
  readonly contextKey: string;
  readonly selectedOption: string;
  readonly outcome: Outcome;
}

/**
 * Where the minority sits (corrections doc §8). A minority concentrated in one context
 * names the escape-hatch condition; a scattered minority says the boundary is not
 * context-shaped and the branch is doing something `contextKey` fails to capture.
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
  readonly distinctContextCount: number;
  readonly optionDistribution: readonly OptionCount[];
  readonly dominantOption: string | null;
  /** 0..1. Zero for an empty group. */
  readonly dominancePercentage: number;
  readonly attestedCount: number;
  /** 0..1. Fraction of samples carrying a non-UNKNOWN outcome. */
  readonly outcomeCoverage: number;
  /**
   * 0..1, or `null` when nothing has been attested.
   *
   * Null is not zero. A group with no attested outcomes has an *unknown* success rate,
   * and rendering that as 0.0% would be exactly the kind of authoritative-looking
   * meaningless number MVP_PLAN §2 forbids.
   */
  readonly attestedSuccessRate: number | null;
  readonly counterexamples: readonly Counterexample[];
  readonly minorityContextConcentration: readonly ContextConcentration[];
  readonly excluded: ExclusionCounts;
}
