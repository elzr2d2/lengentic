import {
  ANALYSIS_RUN_PATH,
  AnalysisRunResponseSchema,
  RECOMMENDATIONS_PATH,
  RecommendationListViewSchema,
  type AnalysisRunResponse,
  type Recommendation,
} from '@lengentic/shared';
import { resolveApiBaseUrl } from './api';

/**
 * `GET /v1/recommendations` and `POST /v1/analysis/run`, as the Dashboard sees them.
 *
 * The vocabulary is imported from `@lengentic/shared`, never restated: that module is the
 * only wire contract (`CLAUDE.md` ## Types), and it is what `p5.analysis-endpoint` types its
 * response against, so a change to either shape is a compile error on both sides at once.
 * Same reason `runs-api.ts` imports `@lengentic/shared/read` rather than hand-writing a twin.
 *
 * The schemas run at runtime as well as supplying types. The API is a separate process and
 * its body is `unknown` until something parses it; `safeParse` turns "the deployed API is
 * older than this page" into a rendered, named state instead of a `TypeError` thrown deep
 * inside a component.
 *
 * ## The envelope, now frozen
 *
 * This file used to accept the list in either of the two shapes a producer could plausibly
 * send — a bare array, or an array under a `recommendations` key — because §21 and §22 froze
 * the entity and the analysis response but neither specified the list read's **envelope**,
 * and `platform/shared/schema/**` was outside `p5.recs-ui`'s `allowed_paths`. The 5b wave
 * gate found the reason there was no agreement to reach: `GET /v1/recommendations` did not
 * exist at all, so there was no producer to agree with. `RecommendationListViewSchema` is now
 * the frozen envelope and the tolerance is gone — one shape, and a second one is contract
 * drift the reader is told about.
 */

export type RecommendationsFetchFailure =
  /** No answer at all: the API is down, the address is wrong, or the request timed out. */
  | { kind: 'unreachable'; reason: string; endpoint: string }
  /** An answer whose status was not 2xx, and which no caller reads as a domain answer. */
  | { kind: 'http-error'; httpStatus: number; endpoint: string }
  /** An answer that did not match `@lengentic/shared`. Contract drift, not an outage. */
  | { kind: 'invalid'; reason: string; endpoint: string };

export type RecommendationListResult =
  /**
   * `hasMore` travels with the page rather than being dropped here. The list is paginated
   * (API-4) and this page asks for the default window, so a reader looking at 50 of 120
   * decision groups has to be told — an understated Decision History is the same failure §19
   * forbids one level up.
   */
  { kind: 'ok'; recommendations: Recommendation[]; hasMore: boolean } | RecommendationsFetchFailure;

export type AnalysisRunResult =
  { kind: 'ok'; response: AnalysisRunResponse } | RecommendationsFetchFailure;

export async function fetchRecommendations(): Promise<RecommendationListResult> {
  const endpoint = `${resolveApiBaseUrl()}${RECOMMENDATIONS_PATH}`;
  const raw = await requestJson(endpoint, 'GET');

  if (raw.kind === 'unreachable') return raw;
  if (raw.kind === 'status') return { kind: 'http-error', httpStatus: raw.httpStatus, endpoint };

  const parsed = RecommendationListViewSchema.safeParse(raw.body);

  return parsed.success
    ? { kind: 'ok', recommendations: parsed.data.recommendations, hasMore: parsed.data.hasMore }
    : { kind: 'invalid', reason: describe(parsed.error), endpoint };
}

/**
 * §22's Analyze action. Explicit and on demand: nothing here polls, retries or schedules, and
 * there is no queue, worker or job table on either side of this call.
 *
 * The response is the ONLY place a SUPPRESSED group exists — §22 is explicit that a
 * suppressed group is returned here and never persisted, so §25's closing beat can only be
 * rendered from what this call returns.
 */
export async function runAnalysis(): Promise<AnalysisRunResult> {
  const endpoint = `${resolveApiBaseUrl()}${ANALYSIS_RUN_PATH}`;
  const raw = await requestJson(endpoint, 'POST');

  if (raw.kind === 'unreachable') return raw;
  if (raw.kind === 'status') return { kind: 'http-error', httpStatus: raw.httpStatus, endpoint };

  const parsed = AnalysisRunResponseSchema.safeParse(raw.body);

  return parsed.success
    ? { kind: 'ok', response: parsed.data }
    : { kind: 'invalid', reason: describe(parsed.error), endpoint };
}

type RawResponse =
  | { kind: 'body'; body: unknown }
  | { kind: 'status'; httpStatus: number }
  | { kind: 'unreachable'; reason: string; endpoint: string };

/**
 * Never throws — same contract as `runs-api.ts`'s reader, for the same reason: "the API is
 * unreachable" is a thing the page should say, and an exception makes Next render a 500 that
 * blames the Dashboard for the API being down.
 *
 * A non-2xx comes back as `status` rather than as a decided failure, because whether a given
 * status is a fault is the caller's question.
 *
 * A near-twin of `runs-api.ts`'s private `requestJson`. Deliberately not extracted: that
 * function belongs to another packet's file, and a refactor across it is outside this
 * packet's blast radius (ENGINEERING_STANDARDS REFAC-3). `BACKLOG.md` carries the fold.
 */
async function requestJson(endpoint: string, method: 'GET' | 'POST'): Promise<RawResponse> {
  try {
    // ASYNC-4: the API is a remote end that can hang. Analysis is a full recomputation over
    // all history (§22), so it gets a longer budget than a read — but still a bounded one.
    const response = await fetch(endpoint, {
      method,
      cache: 'no-store',
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      signal: AbortSignal.timeout(method === 'POST' ? 30000 : 5000),
    });

    if (!response.ok) return { kind: 'status', httpStatus: response.status };

    const body: unknown = await response.json();

    return { kind: 'body', body };
  } catch (error: unknown) {
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.message : 'unknown error',
      endpoint,
    };
  }
}

/**
 * The issue messages only. `ZodError.message` is the whole issue list serialised as JSON,
 * which on a mismatched recommendation list is thousands of characters of noise on a web page.
 *
 * Typed structurally rather than as `ZodError`, so this file never names `zod` — the dashboard
 * depends on `@lengentic/shared`, not on zod, and a direct import would be a dependency it
 * does not declare.
 */
function describe(error: { readonly issues: readonly { readonly message: string }[] }): string {
  return error.issues
    .map((issue) => issue.message)
    .slice(0, 5)
    .join('; ');
}
