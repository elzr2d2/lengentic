/**
 * API access for the Dashboard.
 *
 * The base URL is browser-visible, so it must be the host-reachable address even when the
 * API runs inside docker compose. `NEXT_PUBLIC_` is what makes it available to both the
 * server and client halves of a Next app.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: { database: CheckStatus };
}

export type HealthResult =
  | { kind: 'reachable'; report: HealthReport; httpStatus: number }
  | { kind: 'unreachable'; reason: string };

/**
 * Never throws.
 *
 * "The API is unreachable" is the single most useful thing a status page can tell you, and
 * an exception that renders a 500 tells you the dashboard is broken instead — which is the
 * wrong diagnosis. A degraded API answers with 503 and a body; that is `reachable`, not
 * `unreachable`, and the distinction matters when you are deciding what to restart.
 */
export async function fetchHealth(): Promise<HealthResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
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
    };
  }
}
