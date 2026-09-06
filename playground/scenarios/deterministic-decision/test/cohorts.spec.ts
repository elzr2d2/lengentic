/**
 * Seam: the declared cohort specs → §19's gate arithmetic, recomputed here from the
 * *expanded samples* and nothing else.
 *
 * The specs in `../cohorts.ts` carry their expected gate results in a doc comment. This file
 * is the independent second computation of the same numbers: it re-derives `sampleCount`,
 * `distinctContextKeyCount`, `dominancePercentage`, `dominantOptionAttestedSuccessRate`,
 * `outcomeCoverage` and `counterexamples` from `expandCohort`'s output, against thresholds
 * transcribed from §19's table rather than imported from anywhere. Two independent
 * statements about the same data, so an edit to the counts that the comment does not agree
 * with fails here.
 *
 * The formulas are §18's "Explicit denominators", transcribed:
 *
 *   sampleCount         = |eligible|                         # INCLUDES UNKNOWN outcomes
 *   dominancePercentage = max(optionDistribution) / sampleCount
 *   attested            = eligible where outcome != UNKNOWN
 *   outcomeCoverage     = |attested| / sampleCount
 *   attestedSuccessRate(option) = |attested, option, SUCCESS| / |attested, option|
 *
 * `counterexamples` is §20.1 as corrected in Phase 5a: dominant-option FAILURES **plus**
 * minority-option SUCCESSES. Not every minority row — that is
 * `minorityContextConcentration`, a different population (§18).
 *
 * These are not the analyzer. `playground-not-to-analysis-engine` (`pnpm check:boundaries`)
 * forbids importing it, and a second implementation of the verdict would be free to disagree
 * with the one the product ships. What is asserted here is only that the *data this scenario
 * emits* has the properties the Phase 6 Definition of Done names. Whether §20.1 then emits
 * `DETERMINISTIC_CANDIDATE` and `SUPPRESSED` is `p7.e2e`'s assertion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANDIDATE_COHORT,
  CONTROL_COHORT,
  MINORITY_CONTEXT,
  distinctContextKeys,
  expandCohort,
  type CohortSample,
  type CohortSpec,
} from '../cohorts';

/** §19's defaults, transcribed from the gate table. Not imported — the point of this file is
 *  to be a source independent of both the specs and the analyzer's config. */
const MIN_SAMPLE_COUNT = 30;
const MIN_DISTINCT_CONTEXTS = 5;
const DOMINANCE_THRESHOLD = 0.9;
const SUCCESS_THRESHOLD = 0.9;
const COVERAGE_THRESHOLD = 0.8;

/** Phase 6 Scenario 3's own floor, over and above G2's five. */
const SCENARIO_MIN_DISTINCT_CONTEXTS = 8;

interface Measured {
  readonly sampleCount: number;
  readonly distinctContextKeyCount: number;
  readonly dominantOption: string;
  readonly dominancePercentage: number;
  readonly attestedCount: number;
  readonly outcomeCoverage: number;
  readonly dominantOptionAttestedSuccessRate: number;
  readonly counterexampleCount: number;
  readonly minorityCount: number;
  readonly minorityAttestedSuccessCount: number;
}

function measure(samples: readonly CohortSample[]): Measured {
  const sampleCount = samples.length;

  const counts = new Map<string, number>();
  for (const sample of samples) {
    counts.set(sample.selectedOption, (counts.get(sample.selectedOption) ?? 0) + 1);
  }
  let dominantOption = '';
  let dominantCount = -1;
  for (const [option, count] of counts) {
    if (count > dominantCount) {
      dominantOption = option;
      dominantCount = count;
    }
  }

  const attested = samples.filter((sample) => sample.outcome !== 'UNKNOWN');
  const dominantAttested = attested.filter((sample) => sample.selectedOption === dominantOption);
  const dominantSuccesses = dominantAttested.filter(
    (sample) => sample.outcome === 'SUCCESS',
  ).length;

  const minority = samples.filter((sample) => sample.selectedOption !== dominantOption);
  const minoritySuccesses = minority.filter((sample) => sample.outcome === 'SUCCESS');
  const dominantFailures = samples.filter(
    (sample) => sample.selectedOption === dominantOption && sample.outcome === 'FAILURE',
  );

  return {
    sampleCount,
    distinctContextKeyCount: distinctContextKeys(samples).length,
    dominantOption,
    dominancePercentage: dominantCount / sampleCount,
    attestedCount: attested.length,
    outcomeCoverage: attested.length / sampleCount,
    dominantOptionAttestedSuccessRate: dominantSuccesses / dominantAttested.length,
    counterexampleCount: dominantFailures.length + minoritySuccesses.length,
    minorityCount: minority.length,
    minorityAttestedSuccessCount: minoritySuccesses.length,
  };
}

void describe('expandCohort', () => {
  void it('gives every declared context at least one sample', () => {
    for (const spec of [CANDIDATE_COHORT, CONTROL_COHORT]) {
      const used = new Set(distinctContextKeys(expandCohort(spec)));
      for (const context of spec.contexts) {
        assert.ok(used.has(context), `cohort "${spec.id}" never used context "${context}"`);
      }
    }
  });

  void it('emits exactly the declared number of samples, in block order', () => {
    const samples = expandCohort(CANDIDATE_COHORT);
    const declared = CANDIDATE_COHORT.decisions.reduce((sum, block) => sum + block.count, 0);
    assert.equal(samples.length, declared);
    assert.deepEqual(
      samples.map((sample) => sample.index),
      samples.map((_, index) => index),
    );
  });

  void it('pins a block that declares a contextKey and takes the round-robin otherwise', () => {
    const samples = expandCohort(CANDIDATE_COHORT);
    const minority = samples.filter((sample) => sample.selectedOption === 'NO');
    assert.ok(minority.length > 0, 'candidate cohort has no minority selections');
    for (const sample of minority) {
      assert.equal(sample.contextKey, MINORITY_CONTEXT);
    }
    // §18 `minorityContextConcentration`: "3 minority rows, all in post_refactor_large_diff"
    // names the escape-hatch condition. Spreading them would make a different, more
    // cautionary claim, so the concentration is asserted rather than left to chance.
    assert.equal(new Set(minority.map((sample) => sample.contextKey)).size, 1);
  });

  void it('rejects a spec with no contexts', () => {
    const broken: CohortSpec = { ...CANDIDATE_COHORT, contexts: [] };
    assert.throws(() => expandCohort(broken), /contexts must not be empty/);
  });

  void it('rejects a selected option that is not on offer', () => {
    const broken: CohortSpec = {
      ...CANDIDATE_COHORT,
      decisions: [{ selected: 'MAYBE', outcome: 'SUCCESS', count: 1 }],
    };
    assert.throws(() => expandCohort(broken), /not in availableOptions/);
  });
});

void describe('candidate cohort — every gate passes', () => {
  const measured = measure(expandCohort(CANDIDATE_COHORT));

  void it('G1 sample_count: at least 30 samples', () => {
    assert.ok(
      measured.sampleCount >= MIN_SAMPLE_COUNT,
      `sampleCount ${measured.sampleCount} < ${MIN_SAMPLE_COUNT}`,
    );
  });

  void it('G2 context_diversity: at least 8 distinct contexts, the scenario floor', () => {
    assert.ok(
      measured.distinctContextKeyCount >= SCENARIO_MIN_DISTINCT_CONTEXTS,
      `distinctContextKeyCount ${measured.distinctContextKeyCount} < ${SCENARIO_MIN_DISTINCT_CONTEXTS}`,
    );
    assert.ok(measured.distinctContextKeyCount >= MIN_DISTINCT_CONTEXTS);
  });

  void it('G3 dominance: YES dominates at or above 90%', () => {
    assert.equal(measured.dominantOption, 'YES');
    assert.ok(
      measured.dominancePercentage >= DOMINANCE_THRESHOLD,
      `dominancePercentage ${measured.dominancePercentage} < ${DOMINANCE_THRESHOLD}`,
    );
  });

  void it('G4 outcome_success: the DOMINANT option is at or above 90% attested success', () => {
    assert.ok(
      measured.dominantOptionAttestedSuccessRate >= SUCCESS_THRESHOLD,
      `dominantOptionAttestedSuccessRate ${measured.dominantOptionAttestedSuccessRate} < ${SUCCESS_THRESHOLD}`,
    );
  });

  void it('G5 outcome_coverage: at or above 80%, and strictly below 100%', () => {
    assert.ok(
      measured.outcomeCoverage >= COVERAGE_THRESHOLD,
      `outcomeCoverage ${measured.outcomeCoverage} < ${COVERAGE_THRESHOLD}`,
    );
    // §18: "Excluding UNKNOWN from sampleCount would pin outcomeCoverage to 100% and make
    // G5 unsatisfiable." A cohort with no UNKNOWN rows would exercise G5 vacuously.
    assert.ok(measured.outcomeCoverage < 1, 'cohort has no UNKNOWN outcomes — G5 is vacuous');
  });

  void it('§20.1 counterexamples: the list is non-empty and carries both populations', () => {
    assert.ok(measured.counterexampleCount > 0);
    // The plan: "Include 1-2 minority selections with attested SUCCESS, so the counterexample
    // path is exercised."
    assert.ok(
      measured.minorityAttestedSuccessCount >= 1 && measured.minorityAttestedSuccessCount <= 2,
      `minority attested SUCCESS count ${measured.minorityAttestedSuccessCount} outside 1..2`,
    );
    // The other population: dominant-option failures. Both kinds present means the field is
    // non-empty under either reading of §20.1.
    assert.ok(
      measured.counterexampleCount > measured.minorityAttestedSuccessCount,
      'no dominant-option FAILURE rows — counterexamples rest on one population only',
    );
  });
});

void describe('control cohort — G1 clears, G2 fails, nothing else does', () => {
  const measured = measure(expandCohort(CONTROL_COHORT));

  void it('G1 sample_count: clears, so suppression cannot be blamed on thin data', () => {
    assert.ok(
      measured.sampleCount >= MIN_SAMPLE_COUNT,
      `sampleCount ${measured.sampleCount} < ${MIN_SAMPLE_COUNT}`,
    );
  });

  void it('G2 context_diversity: EXACTLY two distinct contexts, so G2 fails', () => {
    assert.equal(measured.distinctContextKeyCount, 2);
    assert.ok(measured.distinctContextKeyCount < MIN_DISTINCT_CONTEXTS);
  });

  void it('G3, G4 and G5 all pass, leaving G2 the only failing gate', () => {
    assert.ok(
      measured.dominancePercentage >= DOMINANCE_THRESHOLD,
      `G3 would also fail: dominancePercentage ${measured.dominancePercentage}`,
    );
    assert.ok(
      measured.dominantOptionAttestedSuccessRate >= SUCCESS_THRESHOLD,
      `G4 would also fail: dominantOptionAttestedSuccessRate ${measured.dominantOptionAttestedSuccessRate}`,
    );
    assert.ok(
      measured.outcomeCoverage >= COVERAGE_THRESHOLD,
      `G5 would also fail: outcomeCoverage ${measured.outcomeCoverage}`,
    );
  });
});

void describe('the two cohorts are two groups', () => {
  void it('differ in at least one §18 group-key field', () => {
    const keyOf = (spec: CohortSpec): string =>
      [spec.workflowName, spec.workflowVersion, spec.decisionType, spec.contextKeyVersion].join(
        ' ',
      );
    assert.notEqual(keyOf(CANDIDATE_COHORT), keyOf(CONTROL_COHORT));
  });

  void it('together emit at least 30 runs — the Phase 6 DoD floor', () => {
    const total = expandCohort(CANDIDATE_COHORT).length + expandCohort(CONTROL_COHORT).length;
    assert.ok(total >= MIN_SAMPLE_COUNT, `${total} runs < ${MIN_SAMPLE_COUNT}`);
  });
});
