import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type {
  AnalysisRunResponse,
  EvaluatedGroup,
  GateResults,
  GateStatus,
  Recommendation,
} from '@lengentic/shared';
import RecommendationsPage, { ANALYZE_PARAM } from './page';
import { NOT_ATTESTED } from './format';

/**
 * The Recommendations page, rendered — §25 beats 4, 5 and 6.
 *
 * ## The seam
 *
 * `fetch`, and nothing above it — the same seam `runs-pages.spec.ts` settled on, for the same
 * reason. The real `recommendations-api.ts` (its URLs, its `safeParse` against
 * `@lengentic/shared`, its three failure kinds) and the real page components both run against
 * a stubbed HTTP boundary. A test that stubbed `fetchRecommendations` itself would stay green
 * while the page rendered an empty list over a populated API, which is exactly the regression
 * the Phase 2 gate measured on the Run pages.
 *
 * ## Why the fixtures are typed and not parsed here
 *
 * `satisfies Recommendation` / `satisfies AnalysisRunResponse` types every fixture against the
 * frozen wire contract at COMPILE time — the packet's whole point: the mock is typed by the
 * shared schema, so contract drift fails a typecheck rather than surfacing at the demo. The
 * fixtures are then handed to the stub as JSON and parsed at RUNTIME by the page's own reader,
 * so the `superRefine` rules (§19's reporting rule, §22's `recommendationId` biconditional)
 * are exercised by the code under test rather than by the test.
 *
 * Expected values below are the fixtures' own fields and §21/§25's transcribed wording. None
 * is read back off a render.
 */

const FINGERPRINT = 'a1'.repeat(32);

/** §25 beat 4's numbers, verbatim: 48 samples, 9 contexts, 47/1, 95.7% attested. */
const RUN_TESTS: Recommendation = {
  id: 'rec-run-tests',
  category: 'DETERMINISTIC_CANDIDATE',
  analyzerId: 'deterministic-candidate',
  analyzerVersion: '1.0.0',
  groupKey: {
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'run_tests_after_code_change',
    contextKeyVersion: 'v1',
  },
  configSnapshot: {
    minSampleCount: 30,
    minDistinctContexts: 5,
    dominanceThreshold: 0.9,
    successThreshold: 0.9,
    coverageThreshold: 0.8,
  },
  sourceWatermark: '2026-09-01T12:00:00.000Z',
  fingerprint: FINGERPRINT,
  evidence: {
    sampleCount: 48,
    distinctContextKeyCount: 9,
    optionDistribution: [
      { option: 'YES', count: 47, share: 0.979 },
      { option: 'NO', count: 1, share: 0.021 },
    ],
    dominantOption: 'YES',
    dominancePercentage: 0.979,
    attestedCount: 46,
    outcomeCoverage: 0.958,
    dominantOptionAttestedSuccessRate: 0.957,
    minorityContextConcentration: [{ contextKey: 'post_refactor_large_diff', count: 1, share: 1 }],
    excluded: { staleRun: 2, missingContextKey: 3 },
    gates: gates([
      ['PASS', '48 >= 30'],
      ['PASS', '9 >= 5'],
      ['PASS', '97.9% >= 90.0%'],
      ['PASS', '95.7% >= 90.0%'],
      ['PASS', '95.8% >= 80.0%'],
    ]),
  },
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
  firstSeenAt: '2026-09-01T11:00:00.000Z',
  lastSeenAt: '2026-09-01T12:00:00.000Z',
  status: 'OPEN',
  statusNote: null,
  statusChangedAt: null,
};

/**
 * `docs/decisions/0015`'s own `flipEvents` shape, persisted: a DISMISSED tombstone whose
 * evidence was refreshed to a SUPPRESSED run's. `dominantOption` is still `YES` — 38 of 70,
 * 54.3% dominance — and `G3_dominance` is the one gate that FAILs
 * (`platform/api/test/analysis.integration.spec.ts:489`, "38 YES against 32 NO: 54.3%
 * dominance, and nothing else moved"). `configSnapshot`, `sourceWatermark`, `evidence` and
 * `lastSeenAt` carry the suppressing run's numbers; `status`, `firstSeenAt`, `statusNote` and
 * `statusChangedAt` are the human's dismissal and are untouched by the refresh
 * (`resightedColumns`, `recommendations.repository.ts`) — which is why `statusChangedAt`
 * predates `lastSeenAt` here.
 *
 * This is the fixture Reviewer's R1 (5b phase gate) says the suite is missing: before this
 * repair, `recommendations-page.spec.ts` had zero occurrences of `DISMISSED` and zero
 * persisted-row-with-a-failing-gate fixtures.
 */
const DISMISSED_TOMBSTONE: Recommendation = {
  id: 'rec-tombstone',
  category: 'DETERMINISTIC_CANDIDATE',
  analyzerId: 'deterministic-candidate',
  analyzerVersion: '1.0.0',
  groupKey: {
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'promote_release_candidate',
    contextKeyVersion: 'v1',
  },
  configSnapshot: {
    minSampleCount: 30,
    minDistinctContexts: 5,
    dominanceThreshold: 0.9,
    successThreshold: 0.9,
    coverageThreshold: 0.8,
  },
  sourceWatermark: '2026-09-05T09:00:00.000Z',
  fingerprint: 'b2'.repeat(32),
  evidence: {
    sampleCount: 70,
    distinctContextKeyCount: 8,
    optionDistribution: [
      { option: 'YES', count: 38, share: 0.543 },
      { option: 'NO', count: 32, share: 0.457 },
    ],
    dominantOption: 'YES',
    dominancePercentage: 0.543,
    attestedCount: 70,
    outcomeCoverage: 1,
    dominantOptionAttestedSuccessRate: 0.947,
    minorityContextConcentration: [],
    excluded: { staleRun: 0, missingContextKey: 0 },
    gates: gates([
      ['PASS', '70 >= 30'],
      ['PASS', '8 >= 5'],
      ['FAIL', '54.3% >= 90.0%'],
      ['PASS', '94.7% >= 90.0%'],
      ['PASS', '100.0% >= 80.0%'],
    ]),
  },
  counterexamples: [],
  firstSeenAt: '2026-09-01T09:00:00.000Z',
  lastSeenAt: '2026-09-05T09:00:00.000Z',
  status: 'DISMISSED',
  statusNote: 'known trade-off',
  statusChangedAt: '2026-09-03T10:00:00.000Z',
};

/**
 * The empty-counterexamples case — a CANDIDATE whose minority block is the ONLY minority
 * evidence on the page.
 *
 * 47 `FAST` over seven context keys, every one attested SUCCESS, plus 3 `SLOW` in
 * `cold_start`, none of them attested. §20.1 finds nothing: the dominant option never failed,
 * and no minority row succeeded. §18's minority population is nevertheless three rows, all in
 * one context — the two are different populations and neither is computed from the other
 * (`MVP_PLAN_V3.md:967`). Every §19 gate passes at the shipped thresholds: 50 >= 30, 8 >= 5,
 * 94.0% >= 90.0%, 100.0% >= 90.0%, 94.0% >= 80.0%.
 *
 * The previous version of this fixture declared `sampleCount: 20` against a `minSampleCount`
 * of 30 while its G1 read `['PASS', '20 >= 30']`, and a `coverageThreshold` of 0.4 that no
 * deployment can set (`analyzer-config.provider.ts` pins `DEFAULT_CONFIG`; "No environment
 * variable is read"). `GateResultsSchema` does not read `comparison`, so it parsed — and a
 * fixture no producer can emit binds nothing (Tester, 5b phase gate, FINDING 3). These
 * numbers are the shape Tester drove through the real ingest path and read back off the live
 * wire instead.
 */
const SELECT_MODEL: Recommendation = {
  ...RUN_TESTS,
  id: 'rec-select-model',
  groupKey: { ...RUN_TESTS.groupKey, decisionType: 'select_model' },
  evidence: {
    sampleCount: 50,
    distinctContextKeyCount: 8,
    optionDistribution: [
      { option: 'FAST', count: 47, share: 0.94 },
      { option: 'SLOW', count: 3, share: 0.06 },
    ],
    dominantOption: 'FAST',
    dominancePercentage: 0.94,
    attestedCount: 47,
    outcomeCoverage: 0.94,
    dominantOptionAttestedSuccessRate: 1,
    minorityContextConcentration: [{ contextKey: 'cold_start', count: 3, share: 1 }],
    excluded: { staleRun: 1, missingContextKey: 1 },
    gates: gates([
      ['PASS', '50 >= 30'],
      ['PASS', '8 >= 5'],
      ['PASS', '94.0% >= 90.0%'],
      ['PASS', '100.0% >= 90.0%'],
      ['PASS', '94.0% >= 80.0%'],
    ]),
  },
  counterexamples: [],
};

/**
 * §25's closing move — the low-diversity group at `SUPPRESSED / G2 context_diversity (2 < 5)`,
 * with a second failing gate added deliberately.
 *
 * The second failure is the §19 reporting rule under test: "Suppressed by G2" when it also
 * fails G4 understates the problem, and an engineer who fixes only context diversity returns
 * to find it still suppressed. A page that named only the first failing gate would be green
 * against a one-failure fixture.
 */
const SUPPRESSED_GROUP: EvaluatedGroup = {
  groupKey: {
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'batch_iteration_size',
    contextKeyVersion: 'v1',
  },
  verdict: 'SUPPRESSED',
  failedGates: ['G2_context_diversity', 'G4_outcome_success'],
  // `X >= Y` on a FAIL as well as on a PASS: `ratioGate`/`countGate` in
  // `analysis-engine/src/gates.ts:115,123` build one string for both statuses, so the `2 < 5`
  // this fixture used to carry was a comparison no producer emits.
  gates: gates([
    ['PASS', '40 >= 30'],
    ['FAIL', '2 >= 5'],
    ['PASS', '96.0% >= 90.0%'],
    ['FAIL', '61.0% >= 90.0%'],
    ['PASS', '88.0% >= 80.0%'],
  ]),
  dominantOptionAttestedSuccessRate: 0.61,
  recommendationId: null,
};

/**
 * The `N/A` case, and the only place the product can produce one.
 *
 * 36 dominant `YES`, none of them attested, plus 4 minority `NO` all attested SUCCESS, over 8
 * contexts — Tester's own construction against the live API (5b phase gate, FINDING 3). G4 is
 * NOT_APPLICABLE because nothing is attested for the dominant option, which is exactly what
 * makes the rate `null`; coverage is then capped at the minority share, so G5 fails and the
 * group is SUPPRESSED. A SUPPRESSED group persists no row, which is why the null never
 * reaches the recommendation card and why `EvaluatedGroupSchema` now carries the field.
 *
 * No field on this fixture formats to `0.0%`, so the negative assertion against it means "the
 * page did not manufacture a zero" rather than "the page happened not to print one".
 */
const NOTHING_ATTESTED_GROUP: EvaluatedGroup = {
  groupKey: { ...RUN_TESTS.groupKey, decisionType: 'nothing_attested' },
  verdict: 'SUPPRESSED',
  failedGates: ['G5_outcome_coverage'],
  gates: gates([
    ['PASS', '40 >= 30'],
    ['PASS', '8 >= 5'],
    ['PASS', '90.0% >= 90.0%'],
    ['NOT_APPLICABLE', 'no attested outcomes for the dominant option (threshold 90.0%)'],
    ['FAIL', '10.0% >= 80.0%'],
  ]),
  dominantOptionAttestedSuccessRate: null,
  recommendationId: null,
};

const CANDIDATE_GROUP: EvaluatedGroup = {
  groupKey: RUN_TESTS.groupKey,
  verdict: 'CANDIDATE',
  failedGates: [],
  gates: RUN_TESTS.evidence.gates,
  dominantOptionAttestedSuccessRate: RUN_TESTS.evidence.dominantOptionAttestedSuccessRate,
  recommendationId: RUN_TESTS.id,
};

const ANALYSIS: AnalysisRunResponse = {
  evaluatedGroups: [CANDIDATE_GROUP, SUPPRESSED_GROUP],
};

/** §19's report order is the contract; a fixture states the five statuses and comparisons. */
function gates(rows: readonly (readonly [GateStatus, string])[]): GateResults {
  const ids = [
    'G1_sample_count',
    'G2_context_diversity',
    'G3_dominance',
    'G4_outcome_success',
    'G5_outcome_coverage',
  ] as const;

  return ids.map((id, index) => {
    const row = rows[index];

    if (row === undefined) throw new Error(`fixture is missing a result for ${id}`);

    return { id, status: row[0], comparison: row[1] };
  });
}

interface StubbedRoute {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Answers `fetch` from a table keyed by `METHOD /path`, and records what was asked for.
 *
 * The method is part of the key, not just the record: §22's Analyze action is a POST and the
 * list read is a GET, and a page that fetched the analysis endpoint with a GET would otherwise
 * match a POST stub and pass. A path with no entry is a rejected request, not a quiet 200 — a
 * page that asked for something this test did not intend must fail loudly.
 */
function stubApi(routes: Readonly<Record<string, StubbedRoute>>): { readonly asked: string[] } {
  const asked: string[] = [];

  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    asked.push(key);

    const route = routes[key];
    if (route === undefined) {
      return Promise.reject(new Error(`the page requested ${key}, which this test did not stub`));
    }

    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return { asked };
}

/**
 * One page of `GET /v1/recommendations`, in the envelope
 * `platform/shared/schema/recommendation.ts` now freezes. The four fields are written out
 * rather than spread from a default so that a change to the envelope fails here.
 */
function listOf(recommendations: readonly Recommendation[], hasMore = false): StubbedRoute {
  return { status: 200, body: { recommendations, limit: 50, offset: 0, hasMore } };
}

async function renderPage(page: Promise<ReactElement>): Promise<string> {
  // React inserts `<!-- -->` between adjacent text children. Stripping it keeps assertions
  // about the sentences a reader sees from depending on where JSX happened to split them.
  return renderToStaticMarkup(await page).replaceAll('<!-- -->', '');
}

function open(params: Record<string, string> = {}): Promise<ReactElement> {
  return RecommendationsPage({ searchParams: Promise.resolve(params) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('§25 beat 4 — Decision History', () => {
  it('renders every decision group the API returned, with the numbers its claim rests on', async () => {
    const { asked } = stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS, SELECT_MODEL]) });

    const markup = await renderPage(open());

    // No analysis was requested, so no analysis was run. §22: explicit and on demand.
    expect(asked).toStrictEqual(['GET /v1/recommendations']);
    expect(markup).toContain('Decision History');
    expect(markup).toContain('run_tests_after_code_change');
    expect(markup).toContain('demo-workflow @ a1b2c3d');
    expect(markup).toContain('48');
    expect(markup).toContain('YES');
    expect(markup).toContain('97.9%');
    expect(markup).toContain('2.1%');
    expect(markup).toContain('95.7%');
    expect(markup).toContain('select_model');
    // The paired negative: the empty state is a real state of this page (asserted below), so
    // its absence here is what makes the assertions above mean "these groups", not "some".
    expect(markup).not.toContain('No decision group has produced a recommendation yet');
  });

  it('says so when nothing has produced a recommendation, rather than rendering an empty table', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([]) });

    const markup = await renderPage(open());

    expect(markup).toContain('No decision group has produced a recommendation yet');
    expect(markup).not.toContain('run_tests_after_code_change');
  });

  it('calls a bare array contract drift now that the envelope is frozen', async () => {
    // The tolerance this replaces existed because no producer existed: `GET
    // /v1/recommendations` 404ed, and `platform/shared` was outside `p5.recs-ui`'s
    // allowed_paths, so the reader accepted both plausible shapes. One shape is frozen now,
    // and a second one is drift the reader has to name rather than quietly absorb.
    stubApi({ 'GET /v1/recommendations': { status: 200, body: [RUN_TESTS] } });

    const markup = await renderPage(open());

    expect(markup).toContain('contract mismatch');
    expect(markup).not.toContain('run_tests_after_code_change');
  });

  it('says the page is a sample when the API reports more recommendations than it sent', async () => {
    // API-4 paginates this read, so a Decision History rendered from one page is a sample.
    // Saying so is the same rule §19 applies to gates: an understated report is the defect.
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS], true) });

    const markup = await renderPage(open());

    expect(markup).toContain('More recommendations exist than this page shows');
  });

  it('does not claim a further page when the API says there is none', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS], false) });

    const markup = await renderPage(open());

    expect(markup).not.toContain('More recommendations exist than this page shows');
  });
});

describe('§25 beat 5 — the recommendation, counterexamples included', () => {
  it('renders §21 output shape: dominant option, gates, suggested action, note', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS]) });

    const markup = await renderPage(open());

    expect(markup).toContain('DETERMINISTIC_CANDIDATE');
    expect(markup).toContain('Deterministic default candidate');
    expect(markup).toContain('Consider a deterministic default of');
    // Every gate by name, in §19&#39;s report order — not just the ones that are interesting.
    expect(markup).toContain('G1 sample_count');
    expect(markup).toContain('G2 context_diversity');
    expect(markup).toContain('G3 dominance');
    expect(markup).toContain('G4 outcome_success');
    expect(markup).toContain('G5 outcome_coverage');
    expect(markup).toContain('48 &gt;= 30');
    // §21: the thresholds in force, without which a PASS is unreadable. `≥` because the
    // page writes `&ge;`, which is a character in the markup rather than an escape.
    expect(markup).toContain('samples ≥ 30');
    // §21&#39;s Note block, which is "the difference between a recommendation and an overclaim".
    expect(markup).toContain('LenGentic observes chosen options only');
    expect(markup).toContain('Review the counterexamples before removing the branch');
    // §21 removed `severity`, and the page must not reintroduce it.
    expect(markup).not.toContain('severity');
  });

  it('does not suggest a deterministic default off a DISMISSED tombstone whose gates now fail', async () => {
    // Reviewer R1, 5b phase gate. ADR 0015 keeps a DISMISSED row as a tombstone with its
    // evidence refreshed to a SUPPRESSED run's — the gate table can say FAIL while
    // `dominantOption` is still non-null, and the card must not print a suggested action off
    // gates it is itself showing as failed (`CLAUDE.md` `## Product claims`).
    stubApi({ 'GET /v1/recommendations': listOf([DISMISSED_TOMBSTONE]) });

    const markup = await renderPage(open());

    expect(markup).toContain('promote_release_candidate');
    expect(markup).toContain('DISMISSED');
    expect(markup).toContain('G3 dominance');
    expect(markup).toContain('54.3% &gt;= 90.0%');
    // The defect, byte for byte: this sentence must not render beside a FAILing gate table.
    expect(markup).not.toContain('Consider a deterministic default of');
    expect(markup).toContain('A gate above now fails this evidence');
  });

  it('still suggests a deterministic default for an OPEN row whose gates all pass', async () => {
    // The paired negative: R1's guard must not blanket-suppress the sentence for every row,
    // only for one whose own gates FAIL. Regression bound for `recommendations-page.spec.ts`'s
    // pre-existing assertion above.
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS]) });

    const markup = await renderPage(open());

    expect(markup).toContain('Consider a deterministic default of');
    expect(markup).not.toContain('A gate above now fails this evidence');
  });

  it('describes thresholds as evaluated against the evidence shown, not as "when this was produced"', async () => {
    // Secondary half of R1: `ThresholdNote` prints `configSnapshot`, which ADR 0015's
    // `resightedColumns` refreshes to the suppressing run's on a tombstone. "When this was
    // produced" is false there — it was produced under the DISMISSED-over config, not the one
    // shown. The reworded sentence is true of both a fresh row and a refreshed tombstone
    // because `configSnapshot` and `evidence` are always written together.
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS, DISMISSED_TOMBSTONE]) });

    const markup = await renderPage(open());

    expect(markup).not.toContain('when this was produced');
    expect(markup).toContain('Thresholds the evidence above was evaluated against');
  });

  it('renders every counterexample with its contextKey, selected option and attested outcome', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS]) });

    const markup = await renderPage(open());

    expect(markup).toContain('Counterexamples (3)');
    expect(markup).toContain('run-8f2a');
    expect(markup).toContain('run-c41d');
    expect(markup).toContain('run-5b90');
    expect(markup).toContain('post_refactor_large_diff');
    expect(markup).toContain('hotfix_single_file');
    expect(markup).toContain('SUCCESS');
    expect(markup).toContain('FAILURE');
    // §25&#39;s concentration line, which is where the escape-hatch condition comes from.
    expect(markup).toContain('Concentration: 1 of 1 minority row in');
    expect(markup).not.toContain('None found in this sample');
  });

  it('states that no counterexample was found rather than rendering nothing', async () => {
    // `counterexamples` may be empty and is never omitted: "we found none" is a claim the page
    // has to make out loud, or it is indistinguishable from a page that does not report them.
    stubApi({ 'GET /v1/recommendations': listOf([SELECT_MODEL]) });

    const markup = await renderPage(open());

    expect(markup).toContain('Counterexamples (0)');
    expect(markup).toContain('None found in this sample');
  });

  it('renders the minority concentration even when there is no counterexample at all', async () => {
    // The two arrays are DIFFERENT populations and neither is computed from the other
    // (`MVP_PLAN_V3.md:967`; `analysis-engine/src/aggregate.ts:158-169`). This fixture is the
    // case that separates them: dominant option never failed, minority rows never attested,
    // so §20.1 finds nothing while §18's minority block has three rows in one context — the
    // one number the escape hatch is built from, and the only minority evidence on the page.
    //
    // It fails against the shipped `Counterexamples` early return, which returned the "none
    // found" paragraph before `<Concentration>` was ever reached (Reviewer S1, Tester
    // FINDING 2). The suite's only positive concentration assertion ran against RUN_TESTS,
    // whose three counterexamples take the other branch, so deleting `<Concentration>`
    // outright left the suite green.
    stubApi({ 'GET /v1/recommendations': listOf([SELECT_MODEL]) });

    const markup = await renderPage(open());

    expect(markup).toContain('Counterexamples (0)');
    expect(markup).toContain('Concentration: 3 of 3 minority rows in');
    expect(markup).toContain('cold_start');
  });
});

describe('the attested success rate — N/A, never 0.0%', () => {
  it('renders N/A on the group whose dominant option has nothing attested', async () => {
    // The analysis response, not the list read: a null rate forces G4 NOT_APPLICABLE, which
    // caps coverage at the minority share, which fails G5 and suppresses the group — and a
    // SUPPRESSED group persists no row for the recommendation card to render. The suppressed
    // group IS the N/A case, and before this repair the field was not on it at all, so `N/A`
    // rendered 0 times against the real API (Tester, 5b phase gate, FINDING 3).
    stubApi({
      'POST /v1/analysis/run': {
        status: 200,
        body: { evaluatedGroups: [NOTHING_ATTESTED_GROUP] },
      },
      'GET /v1/recommendations': listOf([]),
    });

    const markup = await renderPage(open({ [ANALYZE_PARAM]: '1' }));

    expect(markup).toContain('nothing_attested');
    // Anchored on the element boundary, both ways. A bare `'0.0%'` is a substring of every
    // `90.0%` threshold on the page and would pass while the cell said `0.0%`; `>0.0%` can
    // only match a rendered VALUE, which is the thing under test.
    expect(markup).toContain(`>${NOT_ATTESTED}<`);
    // The whole point. `0.0%` would say every attested outcome failed; `null` says none was
    // ever attested, and the two send a reader to opposite conclusions.
    expect(markup).not.toContain('>0.0%');
  });

  it('renders the rate as a percentage when there is one', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS]) });

    const markup = await renderPage(open());

    expect(markup).toContain('95.7%');
    expect(markup).not.toContain(NOT_ATTESTED);
  });
});

describe('§22 / §25 beat 6 — the Analyze action and the groups it refused', () => {
  it('runs the analysis only when it is asked to, and POSTs to /v1/analysis/run', async () => {
    const { asked } = stubApi({
      'POST /v1/analysis/run': { status: 200, body: ANALYSIS },
      'GET /v1/recommendations': listOf([RUN_TESTS]),
    });

    const markup = await renderPage(open({ [ANALYZE_PARAM]: '1' }));

    expect(asked).toStrictEqual(['POST /v1/analysis/run', 'GET /v1/recommendations']);
    expect(markup).toContain('2 groups evaluated');
  });

  it('renders the suppressed group with EVERY failed gate, not the first (§19)', async () => {
    stubApi({
      'POST /v1/analysis/run': { status: 200, body: ANALYSIS },
      'GET /v1/recommendations': listOf([RUN_TESTS]),
    });

    const markup = await renderPage(open({ [ANALYZE_PARAM]: '1' }));

    expect(markup).toContain('batch_iteration_size');
    expect(markup).toContain('SUPPRESSED');
    expect(markup).toContain('Failed gates');
    expect(markup).toContain('G2 context_diversity, G4 outcome_success');
    // The gate table under the refusal carries the comparisons §25 shows on screen.
    expect(markup).toContain('2 &gt;= 5');
    expect(markup).toContain('61.0% &gt;= 90.0%');
  });

  it('never persists a suppression: the refusal is on the page only while the response is', async () => {
    stubApi({ 'GET /v1/recommendations': listOf([RUN_TESTS]) });

    const markup = await renderPage(open());

    // §22 — no suppression table, no suppression history. Without a fresh analysis response
    // there is nothing to render, and the page must not imply otherwise.
    expect(markup).not.toContain('SUPPRESSED');
    expect(markup).not.toContain('batch_iteration_size');
  });

  it('calls an analysis body that is not the contract a contract mismatch, not a result', async () => {
    // D06, 5b wave gate: every `POST /v1/analysis/run` fixture here used to be valid or a
    // 500, so `runAnalysis`'s `safeParse` could be replaced with a blind pass-through and the
    // whole suite stayed green. The list read had this test; the analysis read did not.
    //
    // The body below is drift a producer could really ship: a group that names ONE failing
    // gate while its `gates` array carries two FAILs — §19's understated report, which
    // `EvaluatedGroupSchema.superRefine` re-derives and refuses on every parse. A blind
    // pass-through would render "Failed gates: G2 context_diversity" and hide G4.
    stubApi({
      'POST /v1/analysis/run': {
        status: 200,
        body: {
          evaluatedGroups: [{ ...SUPPRESSED_GROUP, failedGates: ['G2_context_diversity'] }],
        },
      },
      'GET /v1/recommendations': listOf([RUN_TESTS]),
    });

    const markup = await renderPage(open({ [ANALYZE_PARAM]: '1' }));

    expect(markup).toContain('Analysis failed');
    expect(markup).toContain('contract mismatch');
    expect(markup).toContain('@lengentic/shared');
    // The refusal must not also be rendered as a result: a page showing both would let a
    // reader take the understated gate list as the answer.
    expect(markup).not.toContain('batch_iteration_size');
    // The list read is independent and still succeeded.
    expect(markup).toContain('run_tests_after_code_change');
  });

  it('reports a failed analysis as a failed analysis, not as an empty result', async () => {
    stubApi({
      'POST /v1/analysis/run': { status: 500, body: {} },
      'GET /v1/recommendations': listOf([RUN_TESTS]),
    });

    const markup = await renderPage(open({ [ANALYZE_PARAM]: '1' }));

    expect(markup).toContain('Analysis failed');
    expect(markup).toContain('HTTP 500');
    // The list read is independent and still succeeded, so it is still on the page.
    expect(markup).toContain('run_tests_after_code_change');
  });
});

describe('when the API cannot answer', () => {
  it('names an unreachable API rather than rendering an empty Decision History', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connect ECONNREFUSED')));

    const markup = await renderPage(open());

    expect(markup).toContain('Recommendations unavailable');
    expect(markup).toContain('unreachable');
    expect(markup).toContain('connect ECONNREFUSED');
    expect(markup).not.toContain('No decision group has produced a recommendation yet');
  });

  it('calls a body that is not the contract a contract mismatch, not an outage', async () => {
    stubApi({
      'GET /v1/recommendations': {
        status: 200,
        // A recommendation whose gates are out of §19 report order: parses as an object,
        // fails the contract. Exactly the drift the shared schema exists to catch.
        body: {
          recommendations: [{ ...RUN_TESTS, evidence: { ...RUN_TESTS.evidence, gates: [] } }],
        },
      },
    });

    const markup = await renderPage(open());

    expect(markup).toContain('contract mismatch');
    expect(markup).toContain('@lengentic/shared');
    expect(markup).not.toContain('run_tests_after_code_change');
  });
});
