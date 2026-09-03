import Link from 'next/link';
import { fetchRecommendations, runAnalysis } from '@/lib/recommendations-api';
import { AnalysisResultCard } from './analysis-result-card';
import { DecisionHistoryCard } from './decision-history-card';
import { RecommendationsFailureCard } from './fetch-failure';
import { RecommendationCard } from './recommendation-card';

/**
 * The Recommendations page — §25 beats 4, 5 and 6.
 *
 * - beat 4, **Decision History**: the decision groups and the numbers a claim rests on.
 * - beat 5, the recommendation itself, **counterexamples included**.
 * - beat 6, the closing move: the groups LenGentic **refused** to make a claim about, each
 *   with every gate that failed.
 *
 * ## Why the Analyze action is a form and not a button with an onClick
 *
 * §22's suppressed groups are returned by `POST /v1/analysis/run` and are **never persisted**
 * — no suppression table, no suppression history. So the only way beat 6 can be on the screen
 * is if the page that renders it is the one holding the analysis response.
 *
 * That leaves two shapes. A client component would hold the response in React state and need
 * a browser to prove it renders — the packet forbids starting a server in these tests, and the
 * dashboard's dependency list (outside this packet's `allowed_paths`) has no DOM testing
 * library to mount one with. Or the server component holds it, which is this: a plain
 * `<form method="get">` navigates to `?analyze=1`, and the page performs the POST server-side
 * and renders what came back. Everything on the page then runs in the same async Server
 * Component the existing suite already renders with `renderToStaticMarkup`, against a stubbed
 * `fetch` — the same seam `runs-pages.spec.ts` proved was the one worth watching.
 *
 * The cost is a GET that has a side effect, which is normally a smell. It is bounded here by
 * the two things §21 and §22 already guarantee: re-analysis with the same fingerprint UPDATES
 * evidence and `lastSeenAt` rather than inserting a duplicate, and a suppressed group is never
 * written at all. Re-running converges; it does not accumulate. A `<form>` is used rather than
 * a `<Link>` so Next never prefetches the trigger.
 *
 * `BACKLOG.md` carries the follow-up: a client-side Analyze action with an in-flight state,
 * once the dashboard has a way to test one.
 */

// Analysis is explicit and on demand (§22), and the recommendation list changes underneath
// this page whenever it runs. A cached render would show yesterday's refusal.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** The one query value that triggers the run. Exported so the spec names it once, not twice. */
export const ANALYZE_PARAM = 'analyze';

export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const analyzeRequested = params[ANALYZE_PARAM] === '1';

  // Sequential on purpose: the list read has to see the rows this run just wrote, and running
  // the two together would race the write it depends on.
  const analysis = analyzeRequested ? await runAnalysis() : null;
  const list = await fetchRecommendations();

  return (
    <>
      <h1>Recommendations</h1>
      <p className="tagline">
        <Link href="/">&larr; Platform status</Link> &middot; <Link href="/runs">Runs</Link>
      </p>

      <section className="card">
        <h2 className="card-title">Analyze</h2>
        <p className="note-inline">
          Analysis is explicit and on demand (&sect;22). It reads every Run recorded so far,
          recomputes each decision group, and reports what it decided about <em>all</em> of them
          &mdash; including the ones it refused to make a claim about.
        </p>
        <form className="analyze-form" action="/recommendations" method="get">
          <input type="hidden" name={ANALYZE_PARAM} value="1" />
          <button className="analyze-button" type="submit">
            Analyze
          </button>
        </form>
        {analyzeRequested ? (
          <p className="note-inline">
            <Link href="/recommendations">Clear this result</Link> &mdash; reloading this URL runs
            the analysis again.
          </p>
        ) : null}
      </section>

      {analysis === null ? null : analysis.kind === 'ok' ? (
        <AnalysisResultCard response={analysis.response} />
      ) : (
        <RecommendationsFailureCard title="Analysis failed" failure={analysis} />
      )}

      {list.kind === 'ok' ? (
        <>
          <DecisionHistoryCard recommendations={list.recommendations} />
          {list.recommendations.map((recommendation) => (
            <RecommendationCard key={recommendation.id} recommendation={recommendation} />
          ))}
        </>
      ) : (
        <RecommendationsFailureCard title="Recommendations unavailable" failure={list} />
      )}

      <p className="note">
        Recommendations are <strong>hypotheses with counterevidence</strong>, never assertions.
        Success rates are <em>attested</em> by the caller &mdash; LenGentic records what it was told
        and has no independent way to verify it. It observes chosen options only, never
        counterfactuals, which is why the minority branch is reported rather than averaged away.
      </p>
    </>
  );
}
