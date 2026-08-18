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
 * all five gate cells, `failedGates` AS A SET, `verdict`, the counterexample count, the
 * MEMBERSHIP of every counterexample entry (dominant-option FAILURE or minority-option
 * SUCCESS, nothing else — §20.1), and `minorityContextConcentration` (§18's population —
 * every minority-SELECTED row, outcome irrelevant, recovered from `dominancePercentage` and
 * `sampleCount` since the grid carries no column for it).
 *
 * The three numeric columns are not decoration. `spike/aggregate.ts:100` computes the
 * success rate BLENDED across all options, which §19 forbids in as many words, and no `D`
 * fixture flips G4 between the blended and the dominant-specific reading. A comparator that
 * checked only the gate cells would let the blended rate graduate behind a green corpus.
 * `B3-lo` is the group where the two readings land on opposite sides: 100.00% dominant-only
 * against 89.90% blended.
 *
 * The counterexample COUNT alone cannot catch an inverted population — replacing every
 * dominant-option FAILURE with a dominant-option SUCCESS at the same cardinality passes a
 * count-only check silently (`D6`: 22 either way). Membership is checked separately, against
 * the group's own `dominantOption`, which this function already cross-checks against the
 * grid above.
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
  problems.push(...counterexampleMembershipProblems(aggregate));
  problems.push(...minorityContextConcentrationProblems(aggregate, expected));

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
 * §20.1: a counterexample is a dominant-option FAILURE or a minority-option SUCCESS, and
 * nothing else — never a minority-option FAILURE (evidence FOR the dominant option, not
 * against it), never a dominant-option SUCCESS.
 *
 * Checked against the group's OWN `dominantOption`, which the caller already cross-checked
 * against the grid's `dominantOption` column above. This is a membership check on the
 * ACTUAL output, not a re-derivation of the expected list from raw decision records — it
 * does not reach for `fixtures/inputs/**` or reimplement §20.1's extraction, it only checks
 * the invariant the population must satisfy.
 *
 * This is the check the cardinality-only comparison could not do: inverting the population
 * (dominant-option SUCCESS instead of FAILURE, same count) is invisible to a count check and
 * visible here on every entry.
 */
function counterexampleMembershipProblems(aggregate: DecisionAggregate): string[] {
  const dominantOption = aggregate.dominantOption;
  const outside = aggregate.counterexamples.filter((ce) => {
    const dominantFailure = ce.selectedOption === dominantOption && ce.outcome === 'FAILURE';
    const minoritySuccess = ce.selectedOption !== dominantOption && ce.outcome === 'SUCCESS';
    return !dominantFailure && !minoritySuccess;
  });
  if (outside.length === 0) return [];
  const sample = outside[0]!;
  return [
    `counterexamples: ${outside.length} of ${aggregate.counterexamples.length} entr` +
      `${outside.length === 1 ? 'y is' : 'ies are'} outside §20.1's population (dominant-` +
      `option FAILURE or minority-option SUCCESS) — e.g. decisionId ${sample.decisionId} ` +
      `selected ${sample.selectedOption} (dominant is ${String(dominantOption)}) with ` +
      `outcome ${sample.outcome}`,
  ];
}

/**
 * `minorityContextConcentration` (§18): a group-by over EVERY minority-selected row,
 * outcome irrelevant — a different population from `counterexamples` (§20.1), which is
 * outcome-selective and dominant-inclusive. "Do not compute one from the other"
 * (MVP_PLAN_V3.md:969, restated at :1902).
 *
 * The grid carries no column for this field, so the expected minority total is recovered
 * from columns it DOES carry: every eligible row selects either the dominant option or a
 * minority option, so `minorityTotal = sampleCount - round(dominancePercentage *
 * sampleCount)`. That is an accounting identity over already-verified grid values (both
 * already compared above), not a second implementation of §18 — critically, it never looks
 * at outcome, which is exactly the dimension `counterexamples` differs on.
 *
 * `B4-lo` is the sharpest discriminator in the corpus: dominance is 100% (zero minority
 * selections) while its counterexampleCount is 101 (dominant-option failures). A
 * `minorityContextConcentration` that is secretly `counterexamples` grouped by context would
 * report 101 here where the correct answer is empty. `B3-lo` is the mirror case: 101 minority
 * rows and zero counterexamples.
 */
function minorityContextConcentrationProblems(
  aggregate: DecisionAggregate,
  expected: GridRow,
): string[] {
  const problems: string[] = [];
  const dominantCount = Math.round(expected.dominancePercentage * expected.sampleCount);
  const expectedMinorityTotal = expected.sampleCount - dominantCount;
  const actual = aggregate.minorityContextConcentration;
  const actualTotal = actual.reduce((sum, entry) => sum + entry.count, 0);

  if (expectedMinorityTotal === 0) {
    if (actual.length > 0) {
      problems.push(
        `minorityContextConcentration: expected empty — dominance is 100%, no minority ` +
          `selections exist — got ${actualTotal} across ${actual.length} context(s)`,
      );
    }
    return problems;
  }

  if (actual.length === 0) {
    problems.push(
      `minorityContextConcentration: expected ${expectedMinorityTotal} minority row(s) ` +
        `grouped by context (sampleCount ${expected.sampleCount} minus dominant ` +
        `${dominantCount}), got none — is it computed at all?`,
    );
    return problems;
  }

  if (actualTotal !== expectedMinorityTotal) {
    problems.push(
      `minorityContextConcentration: counts sum to ${actualTotal}, expected ` +
        `${expectedMinorityTotal} (sampleCount ${expected.sampleCount} minus dominant ` +
        `${dominantCount}) — the counterexample population instead of every minority row?`,
    );
  }

  const seen = new Set<string>();
  for (const entry of actual) {
    if (seen.has(entry.contextKey)) {
      problems.push(`minorityContextConcentration: duplicate contextKey "${entry.contextKey}"`);
    }
    seen.add(entry.contextKey);
    if (entry.count <= 0) {
      problems.push(
        `minorityContextConcentration: contextKey "${entry.contextKey}" has non-positive ` +
          `count ${entry.count}`,
      );
    }
    if (actualTotal > 0 && !sameRatio(entry.share, entry.count / actualTotal)) {
      problems.push(
        `minorityContextConcentration: contextKey "${entry.contextKey}" share ` +
          `${asPercent(entry.share)} does not match its count/total ` +
          `${asPercent(entry.count / actualTotal)}`,
      );
    }
  }

  problems.push(...conflatedWithCounterexamplesProblems(aggregate));

  return problems;
}

/**
 * Catches the conflation `minorityContextConcentrationProblems`'s total-and-share checks
 * above cannot: `minorityContextConcentration` built by grouping `counterexamples` by
 * `contextKey` instead of independently over every minority row (MVP_PLAN_V3.md:967-969,
 * restated at :1913 — "do not compute one from the other").
 *
 * The total-cardinality check is silent whenever the two populations' totals coincide by
 * construction, which they do on three real corpus rows (`D7`, both `D8` splits). This check
 * does not need the totals to differ, because it does not compare totals at all. It compares
 * SHAPE: `aggregate.counterexamples` is a MIX of dominant-option FAILUREs (verified by
 * `counterexampleMembershipProblems`, above, to be genuinely non-minority — the dominant
 * option is never a minority selection) and minority-option SUCCESSes. `minorityContextConcentration`'s
 * declared population is every minority row, which by definition EXCLUDES the dominant
 * option entirely. So if `minorityContextConcentration`, grouped by `contextKey`, is
 * IDENTICAL — same keys, same counts, nothing more, nothing less — to `counterexamples`
 * grouped by `contextKey`, while `counterexamples` contains at least one dominant-option
 * FAILURE, the concentration cannot have been computed independently: a genuine minority
 * population would need the true minority-FAILURE rows (invisible to `counterexamples`
 * entirely) to happen to sum to exactly the dominant-option FAILURE count at that same
 * context, for every context, coincidentally. That is the conflation, not a coincidence.
 *
 * Does not reach for `fixtures/inputs/**` and does not re-derive the correct minority
 * population from raw data — it only compares two fields already present on the SAME actual
 * object, one of which (`counterexamples`) is independently membership-checked above.
 */
function conflatedWithCounterexamplesProblems(aggregate: DecisionAggregate): string[] {
  const dominantFailureCount = aggregate.counterexamples.filter(
    (ce) => ce.selectedOption === aggregate.dominantOption && ce.outcome === 'FAILURE',
  ).length;
  if (dominantFailureCount === 0) return [];

  const countByContext = (entries: readonly { contextKey: string }[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.contextKey, (counts.get(entry.contextKey) ?? 0) + 1);
    }
    return counts;
  };

  const counterexampleShape = countByContext(aggregate.counterexamples);
  const concentrationShape = new Map<string, number>(
    aggregate.minorityContextConcentration.map((entry) => [entry.contextKey, entry.count]),
  );

  const identical =
    counterexampleShape.size === concentrationShape.size &&
    [...counterexampleShape].every(
      ([contextKey, count]) => concentrationShape.get(contextKey) === count,
    );

  if (!identical) return [];
  return [
    `minorityContextConcentration: identical, context-for-context, to counterexamples ` +
      `grouped by context — but counterexamples includes ${dominantFailureCount} dominant-` +
      `option FAILURE(s), which are never minority rows. This is §18's population computed ` +
      `FROM §20.1's population instead of independently (MVP_PLAN_V3.md:967-969).`,
  ];
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
