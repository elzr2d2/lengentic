/**
 * Meta-tests for `assertAgainstGrid()` and `assertRepeatedFailures()`.
 *
 * This file is the point of wave 2. The fixtures and the grids are transcription; the
 * comparator is the thing that has to be able to FAIL, and the only way to know it can is to
 * mutate one field of a conforming object at a time and require a throw that names that
 * field. `.toThrow()` on its own would be satisfied by a comparator that threw for an
 * unrelated reason, so every mutation asserts a message pattern.
 *
 * Nothing here imports `src/aggregate`, `src/gates` or either analyzer — they do not exist
 * yet, and an expectation that can reach the analyzer can be sourced from it.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_GRID_ROWS,
  REPEATED_FAILURE_EXPECTATIONS,
  gridRow,
  repeatedFailureRow,
  rowKey,
} from '../../fixtures/expectations';
import type { GridRow } from '../../fixtures/expectations';
import { assertAgainstGrid, assertRepeatedFailures } from './assert-against-grid';
import type { AnalyzedGroup } from './assert-against-grid';
import {
  conforming,
  conformingEmissions,
  withAggregate,
  withEvaluation,
  withGateStatus,
} from './hand-built';

const D1 = gridRow('D1');
const D6 = gridRow('D6');
const D7 = gridRow('D7');
const D8a = gridRow('D8', 'a1b2c3d');
const D8b = gridRow('D8', 'e4f5a6b');
const D10 = gridRow('D10');
const D11 = gridRow('D11');
const B3lo = gridRow('B3-lo');
const B4lo = gridRow('B4-lo');

/**
 * The exact conflation the recovery packet exists to catch: `minorityContextConcentration`
 * built by grouping `counterexamples` by `contextKey` instead of independently over every
 * minority row. `D7` and both `D8` splits are the rows where `minorityTotal` and
 * `counterexampleCount` coincide, so the total-cardinality check alone cannot see this — it
 * has to be caught on shape, not count.
 */
function conflateFromCounterexamples(group: AnalyzedGroup): AnalyzedGroup {
  const counts = new Map<string, number>();
  for (const ce of group.aggregate.counterexamples) {
    counts.set(ce.contextKey, (counts.get(ce.contextKey) ?? 0) + 1);
  }
  const total = group.aggregate.counterexamples.length;
  const conflated = [...counts].map(([contextKey, count]) => ({
    contextKey,
    count,
    share: total > 0 ? count / total : 0,
  }));
  return withAggregate(group, { minorityContextConcentration: conflated });
}

interface Mutation {
  readonly name: string;
  readonly row: GridRow;
  readonly mutate: (group: AnalyzedGroup) => AnalyzedGroup;
  readonly message: RegExp;
}

const MUTATIONS: readonly Mutation[] = [
  {
    name: 'sampleCount off by one',
    row: D1,
    mutate: (group) => withAggregate(group, { sampleCount: 49 }),
    message: /sampleCount: expected 50, got 49/,
  },
  {
    name: 'distinctContextKeyCount off by one',
    row: D1,
    mutate: (group) => withAggregate(group, { distinctContextKeyCount: 11 }),
    message: /distinctContextKeyCount: expected 12, got 11/,
  },
  {
    name: 'the wrong option called dominant',
    row: D1,
    mutate: (group) => withAggregate(group, { dominantOption: 'NO' }),
    message: /dominantOption: expected YES, got NO/,
  },
  {
    name: 'dominantOption null — an empty group reported as a group with a winner',
    row: D1,
    mutate: (group) => withAggregate(group, { dominantOption: null }),
    message: /dominantOption: expected YES, got null/,
  },
  {
    name: 'dominancePercentage wrong in the fourth decimal place',
    row: D6,
    mutate: (group) => withAggregate(group, { dominancePercentage: 0.9666 }),
    message: /dominancePercentage: expected 96\.67%, got 96\.66%/,
  },
  {
    name: 'outcomeCoverage wrong',
    row: D1,
    mutate: (group) => withAggregate(group, { outcomeCoverage: 0.9 }),
    message: /outcomeCoverage: expected 94\.00%, got 90\.00%/,
  },
  {
    // The reason the numeric columns are compared at all. `spike/aggregate.ts:100` blends
    // the success rate across every option; §19 evaluates the dominant option specifically.
    // B3-lo is the one group where the two readings land on opposite sides of the threshold.
    name: 'G4 fed the blended success rate instead of the dominant option (B3-lo)',
    row: B3lo,
    mutate: (group) => withAggregate(group, { dominantOptionAttestedSuccessRate: 0.899 }),
    message: /dominantOptionAttestedSuccessRate: expected 100\.00%, got 89\.90%/,
  },
  {
    name: 'G4 fed the blended success rate instead of the dominant option (D6)',
    row: D6,
    mutate: (group) => withAggregate(group, { dominantOptionAttestedSuccessRate: 0.6071 }),
    message: /dominantOptionAttestedSuccessRate: expected 61\.11%, got 60\.71%/,
  },
  {
    // The packet names this one explicitly. Nothing is attested for D11's dominant option,
    // so the rate is UNKNOWN. Reporting 0 is §2's forbidden lie wearing a number.
    name: 'dominantOptionAttestedSuccessRate of 0 where null is required',
    row: D11,
    mutate: (group) => withAggregate(group, { dominantOptionAttestedSuccessRate: 0 }),
    message: /dominantOptionAttestedSuccessRate: expected null[\s\S]*got 0/,
  },
  {
    name: 'dominantOptionAttestedSuccessRate of null where a rate is required',
    row: D1,
    mutate: (group) => withAggregate(group, { dominantOptionAttestedSuccessRate: null }),
    message: /dominantOptionAttestedSuccessRate: expected 95\.65%, got null/,
  },
  {
    // Also named by the packet. N-A is not PASS: a group carrying an N-A cell is SUPPRESSED.
    name: 'an N-A gate counted as a pass',
    row: D11,
    mutate: (group) => withGateStatus(group, 'G4_outcome_success', 'PASS'),
    message: /gate G4_outcome_success: expected NOT_APPLICABLE, got PASS/,
  },
  {
    name: 'a passing gate reported as N-A',
    row: D1,
    mutate: (group) => withGateStatus(group, 'G4_outcome_success', 'NOT_APPLICABLE'),
    message: /gate G4_outcome_success: expected PASS, got NOT_APPLICABLE/,
  },
  {
    name: 'an N-A gate reported as a failure',
    row: D11,
    mutate: (group) => withGateStatus(group, 'G4_outcome_success', 'FAIL'),
    message: /gate G4_outcome_success: expected NOT_APPLICABLE, got FAIL/,
  },
  {
    name: 'a passing gate reported as failing',
    row: D1,
    mutate: (group) => withGateStatus(group, 'G3_dominance', 'FAIL'),
    message: /gate G3_dominance: expected PASS, got FAIL/,
  },
  {
    name: 'a failing gate reported as passing',
    row: D6,
    mutate: (group) => withGateStatus(group, 'G4_outcome_success', 'PASS'),
    message: /gate G4_outcome_success: expected FAIL, got PASS/,
  },
  {
    name: 'a gate missing from the evaluation entirely',
    row: D1,
    mutate: (group) =>
      withEvaluation(group, {
        gates: group.evaluation.gates.filter((gate) => gate.id !== 'G5_outcome_coverage'),
      }),
    message: /gate G5_outcome_coverage: missing from the evaluation/,
  },
  {
    name: 'gates reported out of §19 report order',
    row: D1,
    mutate: (group) => withEvaluation(group, { gates: [...group.evaluation.gates].reverse() }),
    message: /reported out of order/,
  },
  {
    // The whole reason D10 exists. A short-circuiting implementation reports the first gate
    // to fire and the engineer who fixes only that one comes back to find it still
    // suppressed. Without this mutation, `failedGates = [firstFailure]` is invisible.
    name: 'failedGates missing its second entry (D10 fails G1 and G2 together)',
    row: D10,
    mutate: (group) => withEvaluation(group, { failedGates: ['G1_sample_count'] }),
    message: /failedGates:.*never named: G2_context_diversity/,
  },
  {
    name: 'failedGates naming a gate that did not fail',
    row: D1,
    mutate: (group) => withEvaluation(group, { failedGates: ['G3_dominance'] }),
    message: /failedGates:.*named without failing: G3_dominance/,
  },
  {
    name: 'failedGates listing the same gate twice',
    row: D10,
    mutate: (group) =>
      withEvaluation(group, {
        failedGates: ['G1_sample_count', 'G2_context_diversity', 'G2_context_diversity'],
      }),
    message: /failedGates: contains a duplicate/,
  },
  {
    name: 'an N-A gate leaking into failedGates',
    row: D11,
    mutate: (group) =>
      withEvaluation(group, { failedGates: ['G4_outcome_success', 'G5_outcome_coverage'] }),
    message: /failedGates:.*named without failing: G4_outcome_success/,
  },
  {
    name: 'a suppressed group reported as a candidate',
    row: D6,
    mutate: (group) => withEvaluation(group, { verdict: 'CANDIDATE' }),
    message: /verdict: expected SUPPRESSED, got CANDIDATE/,
  },
  {
    name: 'a candidate reported as suppressed',
    row: D1,
    mutate: (group) => withEvaluation(group, { verdict: 'SUPPRESSED' }),
    message: /verdict: expected CANDIDATE, got SUPPRESSED/,
  },
  {
    // B4-lo is the only SUPPRESSED row in the phase with a non-zero counterexample count,
    // so it is the only fixture that catches an implementation which stops collecting
    // counterexamples once the verdict is already suppressed.
    name: 'counterexample collection skipped because the verdict is suppressed (B4-lo)',
    row: B4lo,
    mutate: (group) => withAggregate(group, { counterexamples: [] }),
    message: /counterexamples: expected 101, got 0/,
  },
  {
    name: 'counterexamples summarized down to one row',
    row: D6,
    mutate: (group) =>
      withAggregate(group, { counterexamples: group.aggregate.counterexamples.slice(0, 1) }),
    message: /counterexamples: expected 22, got 1/,
  },
  {
    // RED-1, reproduced exactly: replacing every dominant-option FAILURE with a
    // dominant-option SUCCESS at the SAME cardinality is invisible to a count-only check.
    // This is the mutation `counterexamples: expected 22, got 22` would have passed before
    // membership was checked.
    name: 'counterexample population inverted — dominant SUCCESS instead of dominant FAILURE, same count (D6)',
    row: D6,
    mutate: (group) =>
      withAggregate(group, {
        counterexamples: group.aggregate.counterexamples.map((ce, index) => ({
          ...ce,
          decisionId: `inverted_${index}`,
          outcome: 'SUCCESS' as const,
        })),
      }),
    message: /counterexamples: 22 of 22 entries are outside §20\.1's population/,
  },
  {
    // A minority-option FAILURE is evidence FOR the dominant option, not against it, and
    // must never leak into `counterexamples` even though it is a minority row.
    name: 'a minority-option FAILURE leaking into counterexamples',
    row: D1,
    mutate: (group) =>
      withAggregate(group, {
        counterexamples: [
          ...group.aggregate.counterexamples,
          {
            decisionId: 'leaked_minority_failure',
            runId: 'hand_built_run_leak',
            contextKey: 'c1',
            selectedOption: 'NO',
            outcome: 'FAILURE',
          },
        ],
      }),
    message: /counterexamples: 1 of 4 entry is outside §20\.1's population/,
  },
  {
    // RED-2: `minorityContextConcentration` is bound by no test today. Emptying it must fail
    // wherever a minority actually exists — B3-lo has zero counterexamples but 101 minority
    // rows, so this mutation is invisible to every other assertion in this function.
    name: 'minorityContextConcentration emptied where a minority exists (B3-lo)',
    row: B3lo,
    mutate: (group) => withAggregate(group, { minorityContextConcentration: [] }),
    message: /minorityContextConcentration: expected 101 minority row\(s\)/,
  },
  {
    // Proves the field is genuinely §18's population and not an alias for `counterexamples`
    // grouped by context: B4-lo has 101 counterexamples but ZERO minority selections
    // (dominance is 100%), so a concentration built from the counterexample list would
    // wrongly sum to 101 here where the correct answer is empty.
    name: 'minorityContextConcentration secretly built from counterexamples instead of every minority row (B4-lo)',
    row: B4lo,
    mutate: (group) =>
      withAggregate(group, {
        minorityContextConcentration: [{ contextKey: 'c1', count: 101, share: 1 }],
      }),
    message: /minorityContextConcentration: expected empty — dominance is 100%/,
  },
  {
    // Attempt 1's surviving defect (recovery-verification.md): totals coincide at D7
    // (minorityTotal 2, counterexampleCount 2), so the cardinality check alone accepts a
    // concentration built from the wrong population. This must be caught on shape.
    name: 'minorityContextConcentration conflated from counterexamples despite coincident totals (D7)',
    row: D7,
    mutate: conflateFromCounterexamples,
    message: /minorityContextConcentration: identical, context-for-context, to counterexamples/,
  },
  {
    name: 'minorityContextConcentration conflated from counterexamples despite coincident totals (D8 a1b2c3d)',
    row: D8a,
    mutate: conflateFromCounterexamples,
    message: /minorityContextConcentration: identical, context-for-context, to counterexamples/,
  },
  {
    name: 'minorityContextConcentration conflated from counterexamples despite coincident totals (D8 e4f5a6b)',
    row: D8b,
    mutate: conflateFromCounterexamples,
    message: /minorityContextConcentration: identical, context-for-context, to counterexamples/,
  },
  {
    // Attempt 1's own follow-up: the share-consistency check has never seen more than one
    // bucket, because `hand-built.ts`'s conforming() only ever emits a single synthetic
    // entry. Counts summing correctly does not imply the shares were computed correctly.
    name: 'minorityContextConcentration share wrong in a multi-context split, counts still sum correctly (B3-lo)',
    row: B3lo,
    mutate: (group) =>
      withAggregate(group, {
        minorityContextConcentration: [
          { contextKey: 'c_a', count: 60, share: 60 / 101 },
          { contextKey: 'c_b', count: 41, share: 0.5 },
        ],
      }),
    message:
      /minorityContextConcentration: contextKey "c_b" share 50\.00% does not match its count\/total 40\.59%/,
  },
];

describe('assertAgainstGrid — accepts a conforming group', () => {
  for (const row of ALL_GRID_ROWS) {
    it(`accepts a hand-built group matching ${rowKey(row)}`, () => {
      expect(() => assertAgainstGrid(conforming(row), row)).not.toThrow();
    });
  }

  it('covers all 27 rows — 12 from the gate expectation grid, 15 boundary groups', () => {
    expect(ALL_GRID_ROWS.length).toBe(27);
  });
});

describe('assertAgainstGrid — mutation check', () => {
  for (const mutation of MUTATIONS) {
    it(`rejects ${mutation.name}`, () => {
      const mutated = mutation.mutate(conforming(mutation.row));
      expect(() => assertAgainstGrid(mutated, mutation.row)).toThrow(mutation.message);
    });
  }

  it('names the row and the source table in the failure', () => {
    const mutated = withAggregate(conforming(D10), { sampleCount: 99 });
    expect(() => assertAgainstGrid(mutated, D10)).toThrow(
      /assertAgainstGrid\(D10@a1b2c3d\).*gate-expectation-grid/s,
    );
  });

  it('reports every mismatch, not the first — the same rule §19 applies to failedGates', () => {
    const mutated = withEvaluation(
      withAggregate(conforming(D1), { sampleCount: 49, outcomeCoverage: 0.5 }),
      { verdict: 'SUPPRESSED' },
    );
    expect(() => assertAgainstGrid(mutated, D1)).toThrow(/3 mismatch\(es\)/);
  });

  it('compares failedGates as a set, so report order is not an assertion', () => {
    const reordered = withEvaluation(conforming(D10), {
      failedGates: ['G2_context_diversity', 'G1_sample_count'],
    });
    expect(() => assertAgainstGrid(reordered, D10)).not.toThrow();
  });

  it('tolerates float noise below the grid’s two printed decimal places', () => {
    const noisy = withAggregate(conforming(D6), { dominancePercentage: 58 / 60 });
    expect(() => assertAgainstGrid(noisy, D6)).not.toThrow();
  });
});

describe('assertRepeatedFailures — accepts conforming emissions', () => {
  for (const row of REPEATED_FAILURE_EXPECTATIONS) {
    it(`accepts the declared emissions for ${row.id}`, () => {
      expect(() => assertRepeatedFailures(conformingEmissions(row), row)).not.toThrow();
    });
  }
});

describe('assertRepeatedFailures — mutation check', () => {
  const R1 = repeatedFailureRow('R1');
  const R4 = repeatedFailureRow('R4');
  const R5 = repeatedFailureRow('R5');

  it('rejects an emission where the fixture expects silence', () => {
    expect(() => assertRepeatedFailures(conformingEmissions(R4), R1)).toThrow(
      /emissions: expected 0 \(silent — no failure at all\), got 1/,
    );
  });

  it('rejects silence where the fixture must emit — the `return []` analyzer', () => {
    expect(() => assertRepeatedFailures([], R4)).toThrow(
      /emission run_R4\/run_tests\/fp_R4_a: expected but not emitted/,
    );
  });

  it('rejects a wrong attemptCount', () => {
    const wrong = conformingEmissions(R4).map((emission) => ({ ...emission, attemptCount: 2 }));
    expect(() => assertRepeatedFailures(wrong, R4)).toThrow(/attemptCount expected 3, got 2/);
  });

  it('rejects an emission whose evidence drags in the interleaved success (R5)', () => {
    const wrong = conformingEmissions(R5).map((emission) => ({
      ...emission,
      attemptCount: 4,
      toolCallIds: ['tc_R5_1', 'tc_R5_2', 'tc_R5_3', 'tc_R5_4'],
    }));
    expect(() => assertRepeatedFailures(wrong, R5)).toThrow(
      /toolCallIds expected \[tc_R5_1, tc_R5_2, tc_R5_4\], got \[tc_R5_1, tc_R5_2, tc_R5_3, tc_R5_4\]/,
    );
  });

  it('rejects evidence listed out of order — §20.2 wants the attempts in order', () => {
    const wrong = conformingEmissions(R5).map((emission) => ({
      ...emission,
      toolCallIds: [...emission.toolCallIds].reverse(),
    }));
    expect(() => assertRepeatedFailures(wrong, R5)).toThrow(/toolCallIds expected/);
  });

  it('rejects an emission keyed on the wrong target', () => {
    const wrong = conformingEmissions(R4).map((emission) => ({
      ...emission,
      inputFingerprint: 'fp_R4_b',
    }));
    expect(() => assertRepeatedFailures(wrong, R4)).toThrow(
      /emission run_R4\/run_tests\/fp_R4_b: emitted but not expected/,
    );
  });

  it('rejects an extra emission alongside the expected one', () => {
    const extra = [
      ...conformingEmissions(R4),
      {
        runId: 'run_R4',
        toolName: 'lint_project',
        inputFingerprint: 'fp_R4_z',
        attemptCount: 3,
        toolCallIds: ['x', 'y', 'z'],
      },
    ];
    expect(() => assertRepeatedFailures(extra, R4)).toThrow(
      /emission run_R4\/lint_project\/fp_R4_z: emitted but not expected/,
    );
  });
});
