import { describe, expect, it } from 'vitest';
import type {
  AnalyzerConfig,
  DecisionAggregate,
  GateEvaluation,
  GateResult as EngineGateResult,
} from '@lengentic/analysis-engine';
import {
  EvaluatedGroupSchema,
  RecommendationEvidenceSchema,
  type AnalyzerConfigSnapshot,
} from '@lengentic/shared';

import {
  toEvaluatedGroup,
  toWireConfigSnapshot,
  toWireCounterexampleOutcome,
  toWireCounterexamples,
  toWireEvidence,
  toWireGroupKey,
} from './evaluated-group';

/**
 * Seam: the engine-output-to-wire mapper, and nothing else. No database, no Nest, no engine
 * function — the inputs below are hand-built `DecisionAggregate` / `GateEvaluation` values, so
 * a failure here is the mapper's and cannot be the analyzer's.
 *
 * ## Where the expected values come from
 *
 * `MVP_PLAN_V3.md` §21's "Required output shape", transcribed field by field: 50 samples, 12
 * distinct contexts, `YES 49 (98.0%) | NO 1 (2.0%)`, 96.0% attested success on the dominant
 * option, 94.0% outcome coverage, the five gate lines with their printed comparisons, the three
 * counterexamples with their runs and outcomes, and `Concentration: 1 of 1 minority row in
 * post_refactor_large_diff`. Not read off the engine and not read off the mapper — an expected
 * value sourced from the code under test cannot fail when that code is wrong
 * (`test-at-seams`).
 *
 * `attestedCount` is the one derived value: 94.0% coverage over 50 samples is 47.
 *
 * The second assertion in each case is `EvaluatedGroupSchema.parse` / `…EvidenceSchema.parse`.
 * That is not decoration: the schema re-derives §19's reporting rule and the verdict
 * biconditional from `gates` on every parse, independently of the engine that produced them, so
 * a mapper that understated a failure fails here rather than at the Dashboard.
 */

const GROUP_KEY = {
  workflowName: 'demo-workflow',
  workflowVersion: 'a1b2c3d',
  decisionType: 'run_tests_after_code_change',
  contextKeyVersion: 'v1',
} as const;

/** §21's five gate lines, verbatim. */
const PASSING_GATES: readonly EngineGateResult[] = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
  { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '98.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
];

/**
 * The two-failure case §19's reporting rule exists for, and the shape of the engine's own D10
 * fixture: G1 and G2 both fail. "Suppressed by G1" alone understates the problem, and an
 * engineer who fixed only the sample count would return to find it still suppressed.
 */
const TWO_FAILURES: readonly EngineGateResult[] = [
  { id: 'G1_sample_count', status: 'FAIL', comparison: '4 >= 30' },
  { id: 'G2_context_diversity', status: 'FAIL', comparison: '2 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '100.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'PASS', comparison: '100.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '100.0% >= 80.0%' },
];

/** §25 beat 6's control group: enough of everything except context diversity. */
const ONLY_G2_FAILS: readonly EngineGateResult[] = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '30 >= 30' },
  { id: 'G2_context_diversity', status: 'FAIL', comparison: '2 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '100.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'PASS', comparison: '100.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '100.0% >= 80.0%' },
];

/** G4 is `NOT_APPLICABLE` when nothing is attested for the dominant option — never `FAIL`. */
const G4_NOT_APPLICABLE: readonly EngineGateResult[] = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '30 >= 30' },
  { id: 'G2_context_diversity', status: 'PASS', comparison: '6 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '100.0% >= 90.0%' },
  {
    id: 'G4_outcome_success',
    status: 'NOT_APPLICABLE',
    comparison: 'no attested outcomes for the dominant option (threshold 90.0%)',
  },
  { id: 'G5_outcome_coverage', status: 'FAIL', comparison: '0.0% >= 80.0%' },
];

function evaluation(gates: readonly EngineGateResult[]): GateEvaluation {
  const failedGates = gates.filter((gate) => gate.status === 'FAIL').map((gate) => gate.id);

  return { gates, failedGates, verdict: failedGates.length === 0 ? 'CANDIDATE' : 'SUPPRESSED' };
}

function aggregate(overrides: Partial<DecisionAggregate> = {}): DecisionAggregate {
  return {
    key: GROUP_KEY,
    sampleCount: 50,
    distinctContextKeyCount: 12,
    optionDistribution: [
      { option: 'YES', count: 49, share: 0.98 },
      { option: 'NO', count: 1, share: 0.02 },
    ],
    dominantOption: 'YES',
    dominancePercentage: 0.98,
    attestedCount: 47,
    outcomeCoverage: 0.94,
    dominantOptionAttestedSuccessRate: 0.96,
    counterexamples: [
      {
        decisionId: 'dec-8f2a',
        runId: 'run-8f2a',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'NO',
        outcome: 'SUCCESS',
      },
      {
        decisionId: 'dec-c41d',
        runId: 'run-c41d',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'YES',
        outcome: 'FAILURE',
      },
      {
        decisionId: 'dec-5b90',
        runId: 'run-5b90',
        contextKey: 'hotfix_single_file',
        selectedOption: 'YES',
        outcome: 'FAILURE',
      },
    ],
    minorityContextConcentration: [{ contextKey: 'post_refactor_large_diff', count: 1, share: 1 }],
    excluded: { staleRun: 0, missingContextKey: 0 },
    ...overrides,
  };
}

describe('toWireGroupKey', () => {
  it('carries §18’s four members and nothing else', () => {
    expect(toWireGroupKey(GROUP_KEY)).toStrictEqual({
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      decisionType: 'run_tests_after_code_change',
      contextKeyVersion: 'v1',
    });
  });
});

describe('toWireEvidence', () => {
  it('reproduces §21’s required output shape field for field', () => {
    const evidence = toWireEvidence(aggregate(), PASSING_GATES);

    expect(evidence).toStrictEqual({
      sampleCount: 50,
      distinctContextKeyCount: 12,
      optionDistribution: [
        { option: 'YES', count: 49, share: 0.98 },
        { option: 'NO', count: 1, share: 0.02 },
      ],
      dominantOption: 'YES',
      dominancePercentage: 0.98,
      attestedCount: 47,
      outcomeCoverage: 0.94,
      dominantOptionAttestedSuccessRate: 0.96,
      minorityContextConcentration: [
        { contextKey: 'post_refactor_large_diff', count: 1, share: 1 },
      ],
      excluded: { staleRun: 0, missingContextKey: 0 },
      gates: [
        { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
        { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
        { id: 'G3_dominance', status: 'PASS', comparison: '98.0% >= 90.0%' },
        { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
        { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
      ],
    });

    expect(() => RecommendationEvidenceSchema.parse(evidence)).not.toThrow();
  });

  /**
   * A 5b Definition-of-Done line, one layer before the renderer: the Dashboard shows `N/A`
   * rather than `0.0%` when nothing is attested, and it can only do that if the null survives
   * the mapper. A `?? 0` here would manufacture the number the plan forbids.
   */
  it('carries an unmeasured dominant success rate across as null, never 0', () => {
    const evidence = toWireEvidence(
      aggregate({ dominantOptionAttestedSuccessRate: null, attestedCount: 0, outcomeCoverage: 0 }),
      G4_NOT_APPLICABLE,
    );

    expect(evidence.dominantOptionAttestedSuccessRate).toBeNull();
    expect(
      RecommendationEvidenceSchema.parse(evidence).dominantOptionAttestedSuccessRate,
    ).toBeNull();
  });

  it('carries a dominantOption of null for a group with no eligible observations', () => {
    const evidence = toWireEvidence(
      aggregate({
        sampleCount: 0,
        distinctContextKeyCount: 0,
        optionDistribution: [],
        dominantOption: null,
        dominancePercentage: 0,
        attestedCount: 0,
        outcomeCoverage: 0,
        dominantOptionAttestedSuccessRate: null,
        counterexamples: [],
        minorityContextConcentration: [],
        excluded: { staleRun: 3, missingContextKey: 2 },
      }),
      TWO_FAILURES,
    );

    expect(evidence.dominantOption).toBeNull();
    expect(evidence.excluded).toStrictEqual({ staleRun: 3, missingContextKey: 2 });
  });
});

describe('toWireCounterexamples', () => {
  it('carries all three of §21’s counterexamples, in order, never summarized away', () => {
    expect(toWireCounterexamples(aggregate().counterexamples)).toStrictEqual([
      {
        decisionId: 'dec-8f2a',
        runId: 'run-8f2a',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'NO',
        outcome: 'SUCCESS',
      },
      {
        decisionId: 'dec-c41d',
        runId: 'run-c41d',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'YES',
        outcome: 'FAILURE',
      },
      {
        decisionId: 'dec-5b90',
        runId: 'run-5b90',
        contextKey: 'hotfix_single_file',
        selectedOption: 'YES',
        outcome: 'FAILURE',
      },
    ]);
  });

  it('returns an empty array rather than omitting the field', () => {
    expect(toWireCounterexamples([])).toStrictEqual([]);
  });

  /**
   * §20.1 admits two outcomes only. Throwing rather than dropping is the point: silently
   * filtering would make "we found no counterevidence" and "we could not represent this
   * counterevidence" the same response, which `CLAUDE.md` ## Product claims does not allow.
   */
  it('refuses an UNKNOWN outcome instead of dropping the counterexample', () => {
    expect(() => toWireCounterexampleOutcome('UNKNOWN')).toThrow(/never UNKNOWN/);
  });
});

describe('toWireConfigSnapshot', () => {
  it('mirrors AnalyzerConfig field for field', () => {
    const config: AnalyzerConfig = {
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    };

    const expected: AnalyzerConfigSnapshot = {
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    };

    expect(toWireConfigSnapshot(config)).toStrictEqual(expected);
  });
});

describe('toEvaluatedGroup', () => {
  it('emits a CANDIDATE naming the persisted row', () => {
    const group = toEvaluatedGroup(aggregate(), evaluation(PASSING_GATES), 'rec-1');

    expect(group.verdict).toBe('CANDIDATE');
    expect(group.failedGates).toStrictEqual([]);
    expect(group.recommendationId).toBe('rec-1');
    expect(group.groupKey).toStrictEqual(GROUP_KEY);
    expect(group.gates.map((gate) => gate.id)).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G3_dominance',
      'G4_outcome_success',
      'G5_outcome_coverage',
    ]);
    expect(() => EvaluatedGroupSchema.parse(group)).not.toThrow();
  });

  /** §19: the report lists EVERY failing gate, not the first. */
  it('reports both failing gates, in report order', () => {
    const group = toEvaluatedGroup(aggregate(), evaluation(TWO_FAILURES), null);

    expect(group.verdict).toBe('SUPPRESSED');
    expect(group.failedGates).toStrictEqual(['G1_sample_count', 'G2_context_diversity']);
    expect(group.recommendationId).toBeNull();
    expect(() => EvaluatedGroupSchema.parse(group)).not.toThrow();
  });

  /**
   * §25's closing beat: the refusal is the claim the product makes, so it has to be on the
   * wire with the gate that caused it — and with all five gates, so a reader can see what did
   * pass.
   */
  it('emits §25 beat 6’s low-diversity suppression with its five gate lines', () => {
    const group = toEvaluatedGroup(aggregate(), evaluation(ONLY_G2_FAILS), null);

    expect(group.failedGates).toStrictEqual(['G2_context_diversity']);
    expect(group.gates).toHaveLength(5);
    expect(group.gates[1]).toStrictEqual({
      id: 'G2_context_diversity',
      status: 'FAIL',
      comparison: '2 >= 5',
    });
    expect(() => EvaluatedGroupSchema.parse(group)).not.toThrow();
  });

  /** `NOT_APPLICABLE` is not `FAIL` and never appears in `failedGates` (§19, engine contract). */
  it('keeps a NOT_APPLICABLE gate out of failedGates', () => {
    const group = toEvaluatedGroup(
      aggregate({ dominantOptionAttestedSuccessRate: null, attestedCount: 0, outcomeCoverage: 0 }),
      evaluation(G4_NOT_APPLICABLE),
      null,
    );

    expect(group.failedGates).toStrictEqual(['G5_outcome_coverage']);
    expect(group.gates[3]?.status).toBe('NOT_APPLICABLE');
    expect(() => EvaluatedGroupSchema.parse(group)).not.toThrow();
  });

  /**
   * The two halves of §22's rule, from the mapper's side. The mapper takes
   * `recommendationId` as an input and cannot derive it, so what is proven here is that the
   * wire contract refuses both wrong pairings — which is what makes passing the wrong one a
   * 500 in `AnalysisService` rather than a bad row on the Dashboard.
   */
  it('produces a group the contract rejects when the id and the verdict disagree', () => {
    const candidateWithNoRow = toEvaluatedGroup(aggregate(), evaluation(PASSING_GATES), null);
    const suppressedWithARow = toEvaluatedGroup(aggregate(), evaluation(ONLY_G2_FAILS), 'rec-1');

    expect(() => EvaluatedGroupSchema.parse(candidateWithNoRow)).toThrow();
    expect(() => EvaluatedGroupSchema.parse(suppressedWithARow)).toThrow();
  });
});
