/**
 * `assertAgainstGrid()` — the whole assertion the wave-3 analyzer packets are measured by.
 *
 * They supply `actual`. They do not own a single `expect` call about analyzer behaviour, and
 * `fixtures/**` and `test/grid/**` are outside their `allowed_paths`, so they physically
 * cannot relax an expectation to make their own code pass.
 *
 * NO TEST FRAMEWORK IS IMPORTED HERE, on purpose. This file is not a `.spec.ts`, so
 * `.dependency-cruiser.cjs`'s `not-to-dev-dep` rule applies to it; more usefully, a
 * comparator that throws a plain `Error` is callable from any runner and from a script.
 *
 * It reports EVERY mismatch it finds, not the first. The same argument §19 makes about
 * `failedGates`: "expected 50 samples, got 26" when the verdict is also wrong understates
 * the problem, and whoever fixes the sample count comes back to find it still red.
 */
import type { DecisionAggregate } from '../../src/types';
import type { GateEvaluation, GateId } from '../../src/gate-contract';
import type { RepeatedFailedAction } from '../../src/tool-call';
import type { GridRow, RepeatedFailureRow } from '../../fixtures/expectations';
import { GRID_GATE_ORDER, rowKey } from '../../fixtures/expectations';

/**
 * One analyzed group: §18's aggregation and §19's gate evaluation over the same input.
 * The seam wave 3 hands across — nothing here knows how either was produced.
 */
export interface AnalyzedGroup {
  readonly aggregate: DecisionAggregate;
  readonly evaluation: GateEvaluation;
}

/**
 * Ratios are compared at four decimal places, which is the two the grid prints as a
 * percentage. Comparing the rounded INTEGERS rather than the rounded ratios keeps the last
 * step off IEEE-754 float equality entirely.
 */
const RATIO_SCALE = 10_000;
const sameRatio = (a: number, b: number): boolean =>
  Math.round(a * RATIO_SCALE) === Math.round(b * RATIO_SCALE);

const asPercent = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;

/**
 * Assert one analyzed group against one row of the gate expectation grid or the threshold
 * boundary table. Throws with every mismatch listed; returns silently on a match.
 *
 * Compares: `sampleCount`, `distinctContextKeyCount`, `dominantOption`, the three numeric
 * columns `dominancePercentage` / `outcomeCoverage` / `dominantOptionAttestedSuccessRate`,
 * all five gate cells, `failedGates` AS A SET, `verdict`, and the counterexample count.
 *
 * The three numeric columns are not decoration. `spike/aggregate.ts:100` computes the
 * success rate BLENDED across all options, which §19 forbids in as many words, and no `D`
 * fixture flips G4 between the blended and the dominant-specific reading. A comparator that
 * checked only the gate cells would let the blended rate graduate behind a green corpus.
 * `B3-lo` is the group where the two readings land on opposite sides: 100.00% dominant-only
 * against 89.90% blended.
 */
export function assertAgainstGrid(actual: AnalyzedGroup, expected: GridRow): void {
  const problems: string[] = [];
  const aggregate = actual.aggregate;
  const evaluation = actual.evaluation;

  if (aggregate.sampleCount !== expected.sampleCount) {
    problems.push(`sampleCount: expected ${expected.sampleCount}, got ${aggregate.sampleCount}`);
  }
  if (aggregate.distinctContextKeyCount !== expected.distinctContextKeyCount) {
    problems.push(
      `distinctContextKeyCount: expected ${expected.distinctContextKeyCount}, ` +
        `got ${aggregate.distinctContextKeyCount}`,
    );
  }
  if (aggregate.dominantOption !== expected.dominantOption) {
    problems.push(
      `dominantOption: expected ${expected.dominantOption}, got ${String(aggregate.dominantOption)}`,
    );
  }
  if (!sameRatio(aggregate.dominancePercentage, expected.dominancePercentage)) {
    problems.push(
      `dominancePercentage: expected ${asPercent(expected.dominancePercentage)}, ` +
        `got ${asPercent(aggregate.dominancePercentage)}`,
    );
  }
  if (!sameRatio(aggregate.outcomeCoverage, expected.outcomeCoverage)) {
    problems.push(
      `outcomeCoverage: expected ${asPercent(expected.outcomeCoverage)}, ` +
        `got ${asPercent(aggregate.outcomeCoverage)}`,
    );
  }

  problems.push(...successRateProblems(aggregate, expected));
  problems.push(...gateProblems(evaluation, expected));

  const expectedFailed = new Set<GateId>(expected.failedGates);
  const actualFailed = new Set<GateId>(evaluation.failedGates);
  const missing = [...expectedFailed].filter((gate) => !actualFailed.has(gate));
  const extra = [...actualFailed].filter((gate) => !expectedFailed.has(gate));
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      `failedGates: expected {${[...expectedFailed].sort().join(', ')}}, ` +
        `got {${[...actualFailed].sort().join(', ')}}` +
        (missing.length > 0 ? ` — never named: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? ` — named without failing: ${extra.join(', ')}` : ''),
    );
  }
  if (evaluation.failedGates.length !== actualFailed.size) {
    problems.push(`failedGates: contains a duplicate — ${evaluation.failedGates.join(', ')}`);
  }

  if (evaluation.verdict !== expected.verdict) {
    problems.push(`verdict: expected ${expected.verdict}, got ${evaluation.verdict}`);
  }
  if (aggregate.counterexamples.length !== expected.counterexampleCount) {
    problems.push(
      `counterexamples: expected ${expected.counterexampleCount}, ` +
        `got ${aggregate.counterexamples.length}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `assertAgainstGrid(${rowKey(expected)}) — ${problems.length} mismatch(es) against the ` +
        `${expected.source}:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

/**
 * `dominantOptionAttestedSuccessRate`, which is the one column where `null` and `0` are
 * different findings rather than different numbers. Null means the dominant option has an
 * empty attested denominator and the rate is UNKNOWN; §18 says it is undefined, not zero,
 * and §2 forbids rendering it as 0.0%.
 */
function successRateProblems(aggregate: DecisionAggregate, expected: GridRow): string[] {
  const actualRate = aggregate.dominantOptionAttestedSuccessRate;
  const expectedRate = expected.dominantOptionAttestedSuccessRate;

  if (expectedRate === null) {
    if (actualRate !== null) {
      return [
        `dominantOptionAttestedSuccessRate: expected null — the grid says N-A and nothing ` +
          `is attested for the dominant option — got ${String(actualRate)}`,
      ];
    }
    return [];
  }
  if (actualRate === null) {
    return [`dominantOptionAttestedSuccessRate: expected ${asPercent(expectedRate)}, got null`];
  }
  if (!sameRatio(actualRate, expectedRate)) {
    return [
      `dominantOptionAttestedSuccessRate: expected ${asPercent(expectedRate)}, ` +
        `got ${asPercent(actualRate)}`,
    ];
  }
  return [];
}

/**
 * All five gate cells, in report order. `NOT_APPLICABLE` is NOT `PASS` — a group carrying an
 * N-A cell is SUPPRESSED, and G4 appears in the report as N-A rather than in `failedGates`.
 * Reporting an unmeasured rate as a failure invents a finding out of missing data; reporting
 * it as a pass is the lie §2 forbids.
 */
function gateProblems(evaluation: GateEvaluation, expected: GridRow): string[] {
  const problems: string[] = [];

  if (evaluation.gates.length !== GRID_GATE_ORDER.length) {
    problems.push(
      `gates: expected ${GRID_GATE_ORDER.length} results, got ${evaluation.gates.length}`,
    );
  }
  for (const [index, id] of GRID_GATE_ORDER.entries()) {
    const result = evaluation.gates.find((gate) => gate.id === id);
    if (result === undefined) {
      problems.push(`gate ${id}: missing from the evaluation`);
      continue;
    }
    if (result.status !== expected.gates[id]) {
      problems.push(`gate ${id}: expected ${expected.gates[id]}, got ${result.status}`);
    }
    if (evaluation.gates[index]?.id !== id) {
      problems.push(`gate ${id}: reported out of order — §19 report order is G1..G5`);
    }
  }
  return problems;
}

/**
 * Assert the §20.2 analyzer's emissions for one `R` fixture. Throws with every mismatch
 * listed; returns silently on a match.
 *
 * There is no gate grid here and there must not be one: §20.2 is a conditions analyzer that
 * emits when all of its conditions hold and is otherwise silent, so a grid would imply a
 * suppression mechanism that does not exist. An expected row with no emissions is the whole
 * claim for `R1`-`R3`.
 *
 * `toolCallIds` are compared IN ORDER. For `R5` that is the discriminator: the streak is
 * `tc_R5_1, tc_R5_2, tc_R5_4`, and an implementation reading "consecutive" over the run's
 * whole timeline either goes silent or drags the unrelated tool's SUCCESS into the evidence.
 */
export function assertRepeatedFailures(
  actual: readonly RepeatedFailedAction[],
  expected: RepeatedFailureRow,
): void {
  const problems: string[] = [];

  if (actual.length !== expected.emissions.length) {
    problems.push(
      `emissions: expected ${expected.emissions.length} (${expected.expectation}), ` +
        `got ${actual.length}`,
    );
  }

  for (const wanted of expected.emissions) {
    const key = `${wanted.runId}/${wanted.toolName}/${wanted.inputFingerprint}`;
    const found = actual.find(
      (emission) =>
        emission.runId === wanted.runId &&
        emission.toolName === wanted.toolName &&
        emission.inputFingerprint === wanted.inputFingerprint,
    );
    if (found === undefined) {
      problems.push(`emission ${key}: expected but not emitted`);
      continue;
    }
    if (found.attemptCount !== wanted.attemptCount) {
      problems.push(
        `emission ${key}: attemptCount expected ${wanted.attemptCount}, got ${found.attemptCount}`,
      );
    }
    if (found.toolCallIds.join(',') !== wanted.toolCallIds.join(',')) {
      problems.push(
        `emission ${key}: toolCallIds expected [${wanted.toolCallIds.join(', ')}], ` +
          `got [${found.toolCallIds.join(', ')}]`,
      );
    }
  }

  for (const emission of actual) {
    const key = `${emission.runId}/${emission.toolName}/${emission.inputFingerprint}`;
    const wanted = expected.emissions.some(
      (candidate) =>
        candidate.runId === emission.runId &&
        candidate.toolName === emission.toolName &&
        candidate.inputFingerprint === emission.inputFingerprint,
    );
    if (!wanted) problems.push(`emission ${key}: emitted but not expected`);
  }

  if (problems.length > 0) {
    throw new Error(
      `assertRepeatedFailures(${expected.id}) — ${problems.length} mismatch(es) against ` +
        `"R fixtures — no gates apply":\n  - ${problems.join('\n  - ')}`,
    );
  }
}
