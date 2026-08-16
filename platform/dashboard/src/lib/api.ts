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

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: { database: CheckStatus };
}

export type HealthResult =
  | { kind: 'reachable'; report: HealthReport; httpStatus: number }
  // `endpoint` is the address actually attempted, not the one a reader might assume. When
  // the server and browser addresses differ, reporting the wrong one sends whoever is
  // debugging to a URL that was never called.
  | { kind: 'unreachable'; reason: string; endpoint: string };

/**
 * Never throws.
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

    return {
      kind: 'reachable',
      report: (await response.json()) as HealthReport,
      httpStatus: response.status,
    };
  } catch (error: unknown) {
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.message : 'unknown error',
      endpoint: baseUrl,
    };
  }
}
