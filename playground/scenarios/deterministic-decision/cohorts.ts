/**
 * The two cohorts Scenario 3 emits, declared as data and expanded into one sample per run.
 *
 * `MVP_PLAN_V3.md` Phase 6 Scenario 3 asks for two decision *groups* out of one command: a
 * candidate that clears every gate, and a low-diversity control that clears G1 and fails G2
 * (§25 beat 6, "the closing move"). §18's group key is
 * `(workflowName, workflowVersion, decisionType, contextKeyVersion)` and `contextKey` is a
 * dimension measured *within* a group — so two cohorts are two group keys, and the only
 * field separating them here is `workflowName`. Same `decisionType`, deliberately: the
 * demo's point is sharper when the identical decision is recommended in one workload and
 * declined in the other, and the visible difference is context diversity rather than a
 * different question being asked.
 *
 * ## Why the counts are what they are
 *
 * Declared, not derived — but every one of them is checked against §19's gate arithmetic by
 * `test/cohorts.spec.ts`, which recomputes G1-G5 from these specs alone. The specs and the
 * expected verdicts are therefore two independent statements, and an edit to one that the
 * other does not agree with fails.
 *
 * This file computes **no verdict**. `playground-not-to-analysis-engine`
 * (`pnpm check:boundaries`) exists because a Playground that could import the analyzer could
 * shape its telemetry to satisfy it; a hand-rolled `DETERMINISTIC_CANDIDATE` here would be a
 * second definition of the analyzer, free to disagree with the one the product ships. The
 * expected verdict below is a *comment* on the data, and the assertion that §20.1 actually
 * emits it belongs to `p7.e2e`.
 *
 * ## `counterexamples` is both populations
 *
 * §20.1, as corrected in Phase 5a (`platform/analysis-engine/src/aggregate.ts`'s module
 * doc): counterexamples are dominant-option FAILURES **plus** minority-option SUCCESSES.
 * That is why the plan's "include 1-2 minority selections with attested SUCCESS, so the
 * counterexample path is exercised" is a statement about counterexamples at all. The
 * candidate cohort carries both kinds — two `YES`/`FAILURE` rows and two `NO`/`SUCCESS`
 * rows — so the field is non-empty for a reason that survives either reading.
 */

/**
 * §14's vocabulary (`platform/shared/schema/decision-events.ts`), restated as the three
 * states a cohort row can declare. `UNKNOWN` is not attested at all — it is the *absence* of
 * an attestation, which is what makes G5's `outcomeCoverage` less than 1 and therefore
 * satisfiable at all (§18 "Explicit denominators").
 */
export type CohortOutcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

/** One block of identical rows: `count` decisions selecting `selected` and ending `outcome`. */
export interface CohortDecisionSpec {
  readonly selected: string;
  readonly outcome: CohortOutcome;
  readonly count: number;
  /**
   * Pins every row of this block to one `contextKey` instead of drawing from the round-robin
   * over `contexts`. §18's `minorityContextConcentration` is the reason: "3 minority rows,
   * all in post_refactor_large_diff" names the escape-hatch condition, while "3 minority rows
   * across 3 different contexts" is a materially different, more cautionary finding. The
   * candidate cohort makes the first statement on purpose.
   */
  readonly contextKey?: string;
}

export interface CohortSpec {
  readonly id: string;
  readonly label: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly decisionType: string;
  readonly contextKeyVersion: string;
  readonly availableOptions: readonly string[];
  /** The round-robin every unpinned row draws its `contextKey` from, in order. */
  readonly contexts: readonly string[];
  readonly decisions: readonly CohortDecisionSpec[];
}

/** One emitted run's worth of decision — what `expandCohort` resolves a spec row to. */
export interface CohortSample {
  /** 0-based, in emission order within the cohort. */
  readonly index: number;
  readonly contextKey: string;
  readonly selectedOption: string;
  readonly outcome: CohortOutcome;
}

const WORKFLOW_VERSION = 'a1b2c3d';
const CONTEXT_KEY_VERSION = 'v1';
const DECISION_TYPE = 'run_tests_after_code_change';
const OPTIONS: readonly string[] = Object.freeze(['YES', 'NO']);

/** The eight contexts the plan names for Scenario 3, in its order. */
const CANDIDATE_CONTEXTS: readonly string[] = Object.freeze([
  'post_edit_small_diff',
  'post_edit_large_diff',
  'post_refactor',
  'post_dependency_bump',
  'post_config_change',
  'post_test_only_change',
  'post_docs_change',
  'post_revert',
]);

/** Where the minority `NO` rows live — a ninth context, and the only one they occupy. */
export const MINORITY_CONTEXT = 'post_refactor_large_diff';

/**
 * 36 samples, 9 distinct contexts, `YES` dominant at 34/36.
 *
 * G1 36 >= 30; G2 9 >= 5; G3 94.4% >= 90%; G4 30/32 = 93.75% >= 90%; G5 34/36 = 94.4% >= 80%.
 * Expected `DETERMINISTIC_CANDIDATE` with four counterexamples — two dominant-option
 * failures and two minority-option successes.
 */
export const CANDIDATE_COHORT: CohortSpec = Object.freeze({
  id: 'candidate',
  label: 'Deterministic candidate — dominant across varied situations, dissent surfaced',
  workflowName: 'demo-workflow',
  workflowVersion: WORKFLOW_VERSION,
  decisionType: DECISION_TYPE,
  contextKeyVersion: CONTEXT_KEY_VERSION,
  availableOptions: OPTIONS,
  contexts: CANDIDATE_CONTEXTS,
  decisions: Object.freeze([
    { selected: 'YES', outcome: 'SUCCESS', count: 30 },
    { selected: 'YES', outcome: 'FAILURE', count: 2 },
    { selected: 'YES', outcome: 'UNKNOWN', count: 2 },
    { selected: 'NO', outcome: 'SUCCESS', count: 2, contextKey: MINORITY_CONTEXT },
  ] as const),
});

/**
 * §25 beat 6. 30 samples — enough to clear G1 — across **exactly two** contexts, so G2 is
 * the one gate that fails and the report names it.
 *
 * G1 30 >= 30; G2 2 < 5 FAIL; G3 96.7% >= 90%; G4 27/28 = 96.4% >= 90%; G5 29/30 = 96.7% >= 80%.
 * Expected `SUPPRESSED`, `G2_context_diversity` among the failed gates, and no
 * Recommendation row persisted.
 *
 * Every gate but G2 passing is the whole point: "if fifty samples all share one contextKey,
 * 98% dominance says nothing about whether the decision is trivial" (§19 "Why G2 exists"). A
 * control that also failed G3 or G4 would let a reader attribute the suppression to
 * something other than context uniformity.
 */
export const CONTROL_COHORT: CohortSpec = Object.freeze({
  id: 'control',
  label: 'Low-diversity control — the same decision, observed in only two situations',
  workflowName: 'batch-iteration-workflow',
  workflowVersion: WORKFLOW_VERSION,
  decisionType: DECISION_TYPE,
  contextKeyVersion: CONTEXT_KEY_VERSION,
  availableOptions: OPTIONS,
  contexts: Object.freeze(['batch_item_first_pass', 'batch_item_retry']),
  decisions: Object.freeze([
    { selected: 'YES', outcome: 'SUCCESS', count: 27 },
    { selected: 'YES', outcome: 'FAILURE', count: 1 },
    { selected: 'YES', outcome: 'UNKNOWN', count: 1 },
    { selected: 'NO', outcome: 'SUCCESS', count: 1 },
  ] as const),
});

export const COHORTS: readonly CohortSpec[] = Object.freeze([CANDIDATE_COHORT, CONTROL_COHORT]);

export class CohortSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortSpecError';
  }
}

/**
 * Expands a cohort into one `CohortSample` per run, giving each unpinned row the next
 * `contexts` entry round-robin.
 *
 * Round-robin rather than a seeded shuffle: with N unpinned rows over C contexts it puts
 * `floor(N/C)` or `ceil(N/C)` rows in every context, so "every declared context is actually
 * observed" is a property of the algorithm rather than a property of one lucky seed.
 * `distinctContextKeyCount` — G2's input, the gate this whole scenario turns on — is then
 * exactly `contexts.length` plus any pinned context, which is what the specs above claim and
 * what `test/cohorts.spec.ts` recomputes.
 */
export function expandCohort(spec: CohortSpec): readonly CohortSample[] {
  const [firstContext] = spec.contexts;
  if (firstContext === undefined) {
    throw new CohortSpecError(`cohort "${spec.id}": contexts must not be empty`);
  }
  const samples: CohortSample[] = [];
  let cursor = 0;
  for (const block of spec.decisions) {
    if (!Number.isInteger(block.count) || block.count <= 0) {
      throw new CohortSpecError(
        `cohort "${spec.id}": decision count must be a positive integer, got ${block.count}`,
      );
    }
    if (!spec.availableOptions.includes(block.selected)) {
      throw new CohortSpecError(
        `cohort "${spec.id}": selected option "${block.selected}" is not in availableOptions`,
      );
    }
    for (let n = 0; n < block.count; n += 1) {
      let contextKey: string;
      if (block.contextKey !== undefined) {
        contextKey = block.contextKey;
      } else {
        // `firstContext` is the `noUncheckedIndexedAccess` (TS-2) fallback, not a reachable
        // state: `cursor % length` is always in range for a non-empty array.
        contextKey = spec.contexts[cursor % spec.contexts.length] ?? firstContext;
        cursor += 1;
      }
      samples.push({
        index: samples.length,
        contextKey,
        selectedOption: block.selected,
        outcome: block.outcome,
      });
    }
  }
  return samples;
}

/** Every context the expansion actually used, pinned ones included, in first-use order. */
export function distinctContextKeys(samples: readonly CohortSample[]): readonly string[] {
  return [...new Set(samples.map((sample) => sample.contextKey))];
}
