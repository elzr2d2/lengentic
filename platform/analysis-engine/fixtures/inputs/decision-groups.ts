/**
 * `D1`-`D11` input data.
 *
 * PROVENANCE, which is the whole point of this wave:
 *
 *   D1-D9   INPUT transcribed verbatim from `spike/fixtures/decisions.json` — the same
 *           declared shapes, the same contexts in the same order, the same option/outcome
 *           blocks in the same order. Phase 0 already reconciled that data with the tables
 *           in MVP_PLAN_V3. Nothing here carries an expected value; the spike file's own
 *           `expect` blocks were NOT transcribed and must not be, because they encode the
 *           pre-2026-08-17 reading of `counterexamples`.
 *   D10-D11 New in Phase 5a. Built from scratch against the shapes named in the
 *           `Negative fixture suite` and `Why D10 and D11 exist` sections.
 *
 * Every EXPECTED value for these groups lives in `../expectations.ts`, transcribed from
 * the `Gate expectation grid` in MVP_PLAN_V3 Phase 5, which is its only legal source.
 */
import type { DecisionGroupSpec } from './expand';

const WORKFLOW = 'demo-workflow';
const VERSION = 'a1b2c3d';
const CKV = 'v1';

export const DECISION_GROUPS: readonly DecisionGroupSpec[] = [
  {
    id: 'D1',
    label: 'Canonical deterministic candidate',
    rationale:
      'The shape the product exists to find: dominant across many varied situations, ' +
      'attested successful, with the single dissent surfaced rather than averaged away.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'run_tests_after_code_change',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_refactor_large_diff',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
      'post_generated_code',
      'post_lockfile_change',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 44 },
      { selected: 'YES', outcome: 'FAILURE', count: 2 },
      { selected: 'YES', outcome: 'UNKNOWN', count: 3 },
      { selected: 'NO', outcome: 'SUCCESS', count: 1, contextKey: 'post_refactor_large_diff' },
    ],
  },

  {
    id: 'D2',
    label: 'Candidate with a spread minority',
    rationale:
      'Passes every gate with less margin than D1, and its minority sits in two different ' +
      'contexts — the escape hatch is wider than one situation.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'skip_redundant_lint_run',
    contextKeyVersion: CKV,
    availableOptions: ['SKIP', 'RUN'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
    ],
    decisions: [
      { selected: 'SKIP', outcome: 'SUCCESS', count: 32 },
      { selected: 'SKIP', outcome: 'FAILURE', count: 3 },
      { selected: 'SKIP', outcome: 'UNKNOWN', count: 2 },
      { selected: 'RUN', outcome: 'SUCCESS', count: 1, contextKey: 'post_dependency_bump' },
      { selected: 'RUN', outcome: 'UNKNOWN', count: 1, contextKey: 'post_dependency_bump' },
      { selected: 'RUN', outcome: 'UNKNOWN', count: 1, contextKey: 'post_config_change' },
    ],
  },

  {
    id: 'D3',
    label: 'Candidate whose minority was always right',
    rationale:
      'Every dissent succeeded and four dominant selections failed. The gates pass and the ' +
      'recommendation stands — but this is the case where reading only the headline number ' +
      'and deleting the branch would be a mistake. The counterexample block is the point.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'auto_apply_formatter',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_refactor_large_diff',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 43 },
      { selected: 'YES', outcome: 'FAILURE', count: 4 },
      { selected: 'NO', outcome: 'SUCCESS', count: 3, contextKey: 'post_refactor_large_diff' },
    ],
  },

  {
    id: 'D4',
    label: 'Low context diversity',
    rationale:
      '96% dominance over 50 samples that only ever saw two situations. This is the fixture ' +
      'the whole G2 argument rests on, and the one the published prior art would promote.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'retry_flaky_network_call',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: ['post_edit_small_diff', 'post_edit_large_diff'],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 44 },
      { selected: 'YES', outcome: 'FAILURE', count: 2 },
      { selected: 'YES', outcome: 'UNKNOWN', count: 2 },
      { selected: 'NO', outcome: 'SUCCESS', count: 2 },
    ],
  },

  {
    id: 'D5',
    label: 'Insufficient sample, hidden behind excluded noise',
    rationale:
      'Twelve eligible decisions, unanimous, well spread. Also 20 decisions from STALE runs ' +
      'and 5 with no contextKey. Raw count is 37, which would clear G1 — so this fixture ' +
      'fails if and only if the exclusion rules actually fire.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'escalate_to_human',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 12 },
      { selected: 'YES', outcome: 'SUCCESS', count: 20, runIsStale: true },
      { selected: 'YES', outcome: 'SUCCESS', count: 5, contextKey: null },
    ],
  },

  {
    id: 'D6',
    label: 'Dominant and frequently wrong',
    rationale:
      'The agent almost always picks YES and it works out only 61% of the time. High ' +
      'dominance here is evidence of a bad habit, not a safe default.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'trust_cached_dependency_graph',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_refactor_large_diff',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
      'post_generated_code',
      'post_lockfile_change',
      'post_ci_config_change',
      'post_schema_change',
      'post_rename',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 33 },
      { selected: 'YES', outcome: 'FAILURE', count: 21 },
      { selected: 'YES', outcome: 'UNKNOWN', count: 4 },
      { selected: 'NO', outcome: 'SUCCESS', count: 1 },
      { selected: 'NO', outcome: 'FAILURE', count: 1 },
    ],
  },

  {
    id: 'D7',
    label: 'Poor outcome coverage',
    rationale:
      '96% dominance and a high success rate — computed over 30 of 50 decisions. The success ' +
      'figure looks excellent because it is measured on a minority of the evidence.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'parallelize_independent_tasks',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_refactor_large_diff',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 28 },
      { selected: 'YES', outcome: 'FAILURE', count: 1 },
      { selected: 'YES', outcome: 'UNKNOWN', count: 19 },
      { selected: 'NO', outcome: 'SUCCESS', count: 1 },
      { selected: 'NO', outcome: 'UNKNOWN', count: 1 },
    ],
  },

  {
    id: 'D8',
    label: 'Version boundary',
    rationale:
      'Fifty samples that would clear G1 comfortably if pooled — 26 under one ' +
      'workflowVersion and 24 under the next. Sized deliberately so that splitting is what ' +
      'changes the answer.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'reuse_previous_plan',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 25, workflowVersion: 'a1b2c3d' },
      { selected: 'NO', outcome: 'SUCCESS', count: 1, workflowVersion: 'a1b2c3d' },
      { selected: 'YES', outcome: 'SUCCESS', count: 23, workflowVersion: 'e4f5a6b' },
      { selected: 'NO', outcome: 'SUCCESS', count: 1, workflowVersion: 'e4f5a6b' },
    ],
  },

  {
    id: 'D9',
    label: 'Genuinely contested decision',
    rationale:
      '60/40 across 45 well-spread samples where both branches work. This is a decision that ' +
      'actually requires judgment, and the honest output is silence.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'request_additional_context',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_refactor_large_diff',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
      'post_merge',
      'post_generated_code',
    ],
    decisions: [
      { selected: 'YES', outcome: 'SUCCESS', count: 25 },
      { selected: 'YES', outcome: 'FAILURE', count: 1 },
      { selected: 'YES', outcome: 'UNKNOWN', count: 1 },
      { selected: 'NO', outcome: 'SUCCESS', count: 15 },
      { selected: 'NO', outcome: 'FAILURE', count: 2 },
      { selected: 'NO', outcome: 'UNKNOWN', count: 1 },
    ],
  },

  {
    id: 'D10',
    label: 'Two gates at once',
    rationale:
      'The discriminator for "every suppression names EVERY failing gate". 12 samples across ' +
      '2 contexts fails G1 and G2 together, so `failedGates = [firstFailure]` is ' +
      'distinguishable from the correct implementation for the first time in the corpus. ' +
      'Every D1-D9 suppressed row fails exactly one gate.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'inline_small_helper',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: ['post_edit_small_diff', 'post_edit_large_diff'],
    decisions: [{ selected: 'YES', outcome: 'SUCCESS', count: 12 }],
  },

  {
    id: 'D11',
    label: 'Nothing attested',
    rationale:
      'Every outcome UNKNOWN, so the dominant option has an empty attested denominator. G5 ' +
      'fails on 0% coverage while G4 is N-A — never FAIL, never 0.0%. Every D1-D10 dominant ' +
      'option has a non-empty attested denominator, so the null path is never otherwise ' +
      'taken. §18: the rate is UNDEFINED when the denominator is 0, and it is not zero.',
    workflowName: WORKFLOW,
    workflowVersion: VERSION,
    decisionType: 'defer_outcome_attestation',
    contextKeyVersion: CKV,
    availableOptions: ['YES', 'NO'],
    contexts: [
      'post_edit_small_diff',
      'post_edit_large_diff',
      'post_refactor',
      'post_dependency_bump',
      'post_config_change',
      'post_test_only_change',
      'post_docs_change',
      'post_revert',
    ],
    decisions: [
      { selected: 'YES', outcome: 'UNKNOWN', count: 38 },
      { selected: 'NO', outcome: 'UNKNOWN', count: 2 },
    ],
  },
];
