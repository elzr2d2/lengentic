import type { AnalyzerConfig } from './config';
import type { DecisionAggregate } from './types';
import type { GateEvaluation, GateId, GateResult } from './gate-contract';
import { GATE_IDS } from './gate-contract';

/**
 * Safety gates G1-G5 (MVP_PLAN_V3.md §19).
 *
 * Each gate is an independent pure function over (aggregate, config). §19 requires every
 * threshold be configurable and every gate individually evaluated — composing them here
 * rather than inlining a boolean chain is what keeps both properties checkable.
 *
 * Graduated from `spike/gates.ts` with two corrections, neither cosmetic:
 *
 * 1. `failedGates` holds gates whose status is `'FAIL'` and NOTHING else. The spike computed
 *    `status !== 'PASS'`, which puts a `NOT_APPLICABLE` G4 into `failedGates` — D11 fails G5
 *    only, with G4 reported N-A, and the spike's reading would report both.
 * 2. Vocabulary (`GateId`, `GateStatus`, `Verdict`, `GateResult`, `GateEvaluation`) is
 *    imported from `./gate-contract`, not redeclared here. `gate-contract.ts` holds the
 *    vocabulary permanently; this file holds only the functions that produce it.
 *
 * No module-level threshold constant appears anywhere in this file — every threshold comes
 * from the `config` parameter, defaulting at the call site to `DEFAULT_CONFIG`.
 */

type Gate = (aggregate: DecisionAggregate, config: AnalyzerConfig) => GateResult;

/** G1 — enough observations to say anything at all. */
export const sampleCountGate: Gate = (aggregate, config) =>
  countGate('G1_sample_count', aggregate.sampleCount, config.minSampleCount);

/**
 * G2 — the observations must span varied situations.
 *
 * Dominance under context uniformity is a property of the sample, not of the decision:
 * fifty observations of one situation say the agent kept meeting that situation, not that
 * the decision is trivial (§19 "Why G2 exists").
 */
export const contextDiversityGate: Gate = (aggregate, config) =>
  countGate('G2_context_diversity', aggregate.distinctContextKeyCount, config.minDistinctContexts);

/** G3 — one option must actually dominate. */
export const dominanceGate: Gate = (aggregate, config) =>
  ratioGate('G3_dominance', aggregate.dominancePercentage, config.dominanceThreshold);

/**
 * G4 — the dominant option must also have worked.
 *
 * Evaluated on `dominantOptionAttestedSuccessRate`, never a blend across every option — a
 * blended rate can clear the gate while the option actually being recommended is the one
 * that fails (§19).
 *
 * `NOT_APPLICABLE` when nothing is attested for the dominant option. An unmeasured success
 * rate is unknown, not zero; reporting "0.0% < threshold" would invent a finding out of
 * missing data, and G5 is what suppresses that group instead.
 */
export const outcomeSuccessGate: Gate = (aggregate, config) => {
  if (aggregate.dominantOptionAttestedSuccessRate === null) {
    return {
      id: 'G4_outcome_success',
      status: 'NOT_APPLICABLE',
      comparison: `no attested outcomes for the dominant option (threshold ${percent(config.successThreshold)})`,
    };
  }
  return ratioGate(
    'G4_outcome_success',
    aggregate.dominantOptionAttestedSuccessRate,
    config.successThreshold,
  );
};

/** G5 — enough of the decisions must carry an attested outcome for G4 to mean anything. */
export const outcomeCoverageGate: Gate = (aggregate, config) =>
  ratioGate('G5_outcome_coverage', aggregate.outcomeCoverage, config.coverageThreshold);

const GATES_IN_ORDER: readonly Gate[] = [
  sampleCountGate,
  contextDiversityGate,
  dominanceGate,
  outcomeSuccessGate,
  outcomeCoverageGate,
];

/**
 * Every gate is evaluated and every failure is reported — never the first only.
 *
 * Short-circuiting would understate the problem: an engineer who saw only "suppressed by
 * G2", fixed context diversity, and re-ran would find it still suppressed by G4 with no
 * warning that a second problem existed (§19 "Reporting rule").
 */
export function evaluateGates(
  aggregate: DecisionAggregate,
  config: AnalyzerConfig,
): GateEvaluation {
  const gates = GATES_IN_ORDER.map((gate) => gate(aggregate, config));
  // Report order is fixed to GATE_IDS (G1..G5) regardless of evaluation order above, so a
  // future reordering of GATES_IN_ORDER cannot silently reorder the report.
  const ordered = GATE_IDS.map((id) => gates.find((g) => g.id === id) ?? assertNever(id));
  const failedGates = ordered.filter((g) => g.status === 'FAIL').map((g) => g.id);
  return {
    gates: ordered,
    failedGates,
    verdict: failedGates.length === 0 ? 'CANDIDATE' : 'SUPPRESSED',
  };
}

function assertNever(id: GateId): never {
  throw new Error(`no gate result produced for ${id}`);
}

function countGate(id: GateId, actual: number, threshold: number): GateResult {
  return {
    id,
    status: actual >= threshold ? 'PASS' : 'FAIL',
    comparison: `${actual} >= ${threshold}`,
  };
}

function ratioGate(id: GateId, actual: number, threshold: number): GateResult {
  return {
    id,
    status: actual >= threshold ? 'PASS' : 'FAIL',
    comparison: `${percent(actual)} >= ${percent(threshold)}`,
  };
}

export function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
