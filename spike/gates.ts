import type { AnalyzerConfig } from './config.ts';
import type { DecisionAggregate } from './types.ts';

/**
 * Safety gates G1–G5 (MVP_PLAN §71).
 *
 * Each gate is an independent pure function over (aggregate, config). That is a hard
 * requirement, not a style preference: §74 requires each gate be individually
 * configurable and §85 requires each be unit-tested in isolation. Composing them here
 * rather than inlining a boolean chain is what makes both possible.
 */

export type GateId =
  | 'G1_sample_count'
  | 'G2_context_diversity'
  | 'G3_dominance'
  | 'G4_outcome_success'
  | 'G5_outcome_coverage';

export type GateStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export type Verdict = 'CANDIDATE' | 'SUPPRESSED';

export interface GateResult {
  readonly id: GateId;
  readonly label: string;
  readonly status: GateStatus;
  /** Human-readable comparison, e.g. "12 >= 5" or "60.7% >= 90.0%". */
  readonly comparison: string;
}

export interface GateEvaluation {
  readonly gates: readonly GateResult[];
  readonly failedGates: readonly GateId[];
  readonly verdict: Verdict;
}

type Gate = (aggregate: DecisionAggregate, config: AnalyzerConfig) => GateResult;

/** G1 — enough observations to say anything at all. */
export const sampleCountGate: Gate = (aggregate, config) =>
  countGate('G1_sample_count', 'sample_count', aggregate.sampleCount, config.minSampleCount);

/**
 * G2 — the observations must span varied situations.
 *
 * The gate that matters most. Dominance under context uniformity is a property of the
 * sample, not of the decision: fifty observations of one situation say the agent kept
 * meeting that situation, not that the decision is trivial (§71).
 */
export const contextDiversityGate: Gate = (aggregate, config) =>
  countGate(
    'G2_context_diversity',
    'context_diversity',
    aggregate.distinctContextCount,
    config.minDistinctContexts,
  );

/** G3 — one option must actually dominate. */
export const dominanceGate: Gate = (aggregate, config) =>
  ratioGate('G3_dominance', 'dominance', aggregate.dominancePercentage, config.dominanceThreshold);

/**
 * G4 — the dominant option must also have worked.
 *
 * NOT_APPLICABLE when nothing has been attested. An unmeasured success rate is unknown,
 * not zero, and reporting "0.0% < 90.0%" would invent a finding out of missing data.
 * G5 is what suppresses that group.
 */
export const outcomeSuccessGate: Gate = (aggregate, config) => {
  if (aggregate.attestedSuccessRate === null) {
    return {
      id: 'G4_outcome_success',
      label: 'outcome_success',
      status: 'NOT_APPLICABLE',
      comparison: `no attested outcomes (threshold ${percent(config.successThreshold)})`,
    };
  }
  return ratioGate(
    'G4_outcome_success',
    'outcome_success',
    aggregate.attestedSuccessRate,
    config.successThreshold,
  );
};

/** G5 — enough of the decisions must carry an attested outcome for G4 to mean anything. */
export const outcomeCoverageGate: Gate = (aggregate, config) =>
  ratioGate(
    'G5_outcome_coverage',
    'outcome_coverage',
    aggregate.outcomeCoverage,
    config.coverageThreshold,
  );

export const ALL_GATES: readonly Gate[] = [
  sampleCountGate,
  contextDiversityGate,
  dominanceGate,
  outcomeSuccessGate,
  outcomeCoverageGate,
];

/**
 * Every gate is evaluated and every failure is reported.
 *
 * Short-circuiting on the first failure would understate the problem: an engineer who
 * saw only "suppressed by G2", fixed context diversity, and re-ran would find it still
 * suppressed by G4 with no warning that a second problem existed.
 */
export function evaluateGates(
  aggregate: DecisionAggregate,
  config: AnalyzerConfig,
): GateEvaluation {
  const gates = ALL_GATES.map((gate) => gate(aggregate, config));
  const failedGates = gates.filter((g) => g.status !== 'PASS').map((g) => g.id);
  return {
    gates,
    failedGates,
    verdict: failedGates.length === 0 ? 'CANDIDATE' : 'SUPPRESSED',
  };
}

function countGate(id: GateId, label: string, actual: number, threshold: number): GateResult {
  return {
    id,
    label,
    status: actual >= threshold ? 'PASS' : 'FAIL',
    comparison: `${actual} >= ${threshold}`,
  };
}

function ratioGate(id: GateId, label: string, actual: number, threshold: number): GateResult {
  return {
    id,
    label,
    status: actual >= threshold ? 'PASS' : 'FAIL',
    comparison: `${percent(actual)} >= ${percent(threshold)}`,
  };
}

export function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
