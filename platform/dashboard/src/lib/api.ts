import { HealthReportSchema, type HealthReport } from '@lengentic/shared/read';

/**
 * API access for the Dashboard.
 *
 * Two addresses, because there are two callers, and one value cannot serve both.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is inlined at build time and is what the **browser** must use:
 * a host-reachable address. A Server Component runs inside the dashboard container, where
 * that same address resolves to its own loopback with nothing listening on it — which is
 * exactly how this page came to render "API unreachable / fetch failed" under
 * `docker compose` while both containers were healthy. Server-side callers need the compose
 * service name, supplied at runtime as `API_BASE_URL_INTERNAL`.
 *
 * Deliberately not `NEXT_PUBLIC_`: an internal hostname inlined into the client bundle is
 * both useless to the browser and a small disclosure of the deployment's shape.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

/**
 * Falls back to the public address when no internal one is configured, which is the correct
 * answer for `pnpm dev` on a developer's machine — there, the two are the same host.
 */
export function resolveApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return API_BASE_URL;
  }

  return process.env.API_BASE_URL_INTERNAL ?? API_BASE_URL;
}

export type HealthResult =
  | { kind: 'reachable'; report: HealthReport; httpStatus: number }
  // The API answered, but not with a `HealthReport`: an error-filter 500 body, a proxy page,
  // an older or newer API. The API is up; what it said is unreadable. Not `unreachable`,
  // which would send whoever is debugging to restart a process that is running.
  | { kind: 'invalid'; reason: string; httpStatus: number; endpoint: string }
  // `endpoint` is the address actually attempted, not the one a reader might assume. When
  // the server and browser addresses differ, reporting the wrong one sends whoever is
  // debugging to a URL that was never called.
  | { kind: 'unreachable'; reason: string; endpoint: string };

/**
 * Never throws, and never trusts the body: it is parsed against `HealthReportSchema`.
 *
 * "The API is unreachable" is the single most useful thing a status page can tell you, and
 * an exception that renders a 500 tells you the dashboard is broken instead — which is the
 * wrong diagnosis. A degraded API answers with 503 and a body; that is `reachable`, not
 * `unreachable`, and the distinction matters when you are deciding what to restart.
 */
export async function fetchHealth(): Promise<HealthResult> {
  const baseUrl = resolveApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    // A non-JSON body (a proxy's HTML error page) is an answer too: it parses to `undefined`
    // and lands in `invalid` below, not in `unreachable`.
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = HealthReportSchema.safeParse(body);

    if (!parsed.success) {
      return {
        kind: 'invalid',
        reason: parsed.error.issues
          .map((issue) => issue.message)
          .slice(0, 5)
          .join('; '),
        httpStatus: response.status,
        endpoint: baseUrl,
      };
    }

    return { kind: 'reachable', report: parsed.data, httpStatus: response.status };
  } catch (error: unknown) {
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.message : 'unknown error',
      endpoint: baseUrl,
    };
  }
}
