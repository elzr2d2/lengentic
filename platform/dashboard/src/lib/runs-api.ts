import {
  RunDetailViewSchema,
  RunListViewSchema,
  RunsListQuerySchema,
  type RunDetailView,
  type RunListView,
  type RunsListQuery,
} from '@lengentic/shared/read';
import { resolveApiBaseUrl } from './api';

/**
 * `GET /v1/runs` and `GET /v1/runs/:id`, as the Dashboard sees them.
 *
 * The response vocabulary is imported, never restated. `@lengentic/shared/read` is the same
 * module `platform/api/src/runs/runs.controller.ts` types its return against, so a change to
 * the response shape is a compile error on both sides at once. A hand-written twin here
 * would be a second contract that agrees with the first only until someone edits one of them
 * — `src/lib/api.ts`'s `HealthReport` is the instance of that already in the tree.
 *
 * The schemas are used at runtime as well as for their types: the API is a separate process
 * and its body is `unknown` until something parses it. `safeParse` turns "the deployed API
 * is older than this page" into a rendered, named state instead of a `TypeError` thrown deep
 * inside a component.
 */

export type RunsFetchFailure =
  /** No answer at all: the API is down, the address is wrong, or the request timed out. */
  | { kind: 'unreachable'; reason: string; endpoint: string }
  /** An answer whose status was not 2xx, and which no caller reads as a domain answer. */
  | { kind: 'http-error'; httpStatus: number; endpoint: string }
  /** An answer that did not match `@lengentic/shared/read`. Contract drift, not an outage. */
  | { kind: 'invalid'; reason: string; endpoint: string };

export type RunListResult = { kind: 'ok'; list: RunListView } | RunsFetchFailure;

export type RunDetailResult =
  | { kind: 'ok'; run: RunDetailView }
  /** The one status that is a domain answer rather than a fault (ENGINEERING_STANDARDS ERR-3). */
  | { kind: 'not-found' }
  | RunsFetchFailure;

/**
 * Reads a page query out of a URL's search params.
 *
 * Uses the API's own `RunsListQuerySchema` — including its `max(200)` — so a link carrying
 * `?limit=5000` is answered here with the defaults rather than by a 400 from the API that
 * the page would then have to render as an error. Anything unparseable falls back to the
 * first page: a malformed query string is a bad link, not a broken run.
 */
export function parseRunsListQuery(params: Record<string, string | string[] | undefined>): {
  query: RunsListQuery;
  rejected: boolean;
} {
  const parsed = RunsListQuerySchema.safeParse(params);

  if (parsed.success) return { query: parsed.data, rejected: false };

  return { query: RunsListQuerySchema.parse({}), rejected: true };
}

export async function fetchRunList(query: RunsListQuery): Promise<RunListResult> {
  const endpoint = `${resolveApiBaseUrl()}/v1/runs?limit=${String(query.limit)}&offset=${String(query.offset)}`;
  const raw = await requestJson(endpoint);

  if (raw.kind === 'unreachable') return raw;
  if (raw.kind === 'status') return { kind: 'http-error', httpStatus: raw.httpStatus, endpoint };

  const parsed = RunListViewSchema.safeParse(raw.body);

  return parsed.success
    ? { kind: 'ok', list: parsed.data }
    : { kind: 'invalid', reason: describe(parsed.error), endpoint };
}

export async function fetchRunDetail(id: string): Promise<RunDetailResult> {
  const endpoint = `${resolveApiBaseUrl()}/v1/runs/${encodeURIComponent(id)}`;
  const raw = await requestJson(endpoint);

  if (raw.kind === 'unreachable') return raw;

  if (raw.kind === 'status') {
    // The controller answers 404 for an id it has no row for. That is not a fault, and
    // rendering it as one would tell the reader the Dashboard is broken.
    if (raw.httpStatus === 404) return { kind: 'not-found' };

    return { kind: 'http-error', httpStatus: raw.httpStatus, endpoint };
  }

  const parsed = RunDetailViewSchema.safeParse(raw.body);

  return parsed.success
    ? { kind: 'ok', run: parsed.data }
    : { kind: 'invalid', reason: describe(parsed.error), endpoint };
}

type RawResponse =
  | { kind: 'body'; body: unknown }
  | { kind: 'status'; httpStatus: number }
  | { kind: 'unreachable'; reason: string; endpoint: string };

/**
 * Never throws — same contract as `fetchHealth`, for the same reason: "the API is
 * unreachable" is a thing the page should say, and an exception makes Next render a 500
 * that blames the Dashboard for the API being down.
 *
 * A non-2xx comes back as `status` rather than as a decided failure, because whether a given
 * status is a fault is the caller's question: 404 is an outage on the list endpoint and an
 * ordinary answer on the detail one.
 */
async function requestJson(endpoint: string): Promise<RawResponse> {
  try {
    // ASYNC-4: the API is a remote end that can hang. Same budget as `fetchHealth`.
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
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
 * which on a mismatched run list is thousands of characters of noise on a web page.
 *
 * Typed structurally rather than as `ZodError`, so this file never names `zod`. The
 * dashboard depends on `@lengentic/shared`, not on zod, and a direct import would be a
 * dependency it does not declare — reaching the real package only because pnpm resolves
 * from the linked workspace's own tree.
 */
function describe(error: { readonly issues: readonly { readonly message: string }[] }): string {
  return error.issues
    .map((issue) => issue.message)
    .slice(0, 5)
    .join('; ');
}
