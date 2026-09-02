import { resolveApiBaseUrl } from '@/lib/api';

/**
 * §16 / ADR 0014 decision 2 — the one number `GET /v1/runs/:id` cannot answer:
 * `GET /v1/runs/:id/summary`'s `droppedTelemetryEventCount`, folded in at the persistence
 * edge from a batch's `droppedSinceLastBatch` field.
 *
 * A tiny, purpose-built reader rather than an addition to `lib/runs-api.ts`: this lane's
 * `allowed_paths` is `platform/dashboard/src/app/runs/**`, not `platform/dashboard/src/lib/**`
 * — and `RunSummary` (`platform/api/src/runs/run-summary.ts`) has no shared Zod schema to
 * `safeParse` against yet; its own header explains why it lives under `platform/api/src/**`
 * rather than `platform/shared/read/**`. `runs-api.ts`'s schema-validated pattern is therefore
 * not reachable here without inventing a hand-rolled twin of a contract this lane does not own.
 *
 * Never throws, mirroring `runs-api.ts`'s own `requestJson` and `lib/api.ts`'s `fetchHealth`:
 * a run detail page that fails to answer this one extra question must still render every
 * other card. `null` covers both "the platform said no drop count has been reported" AND
 * "this request could not be answered at all" — the Ingestion Health card's existing
 * `not reported` + reason already covers both without this function inventing a second
 * vocabulary for what renders identically either way.
 */
export async function fetchDroppedTelemetryEventCount(runId: string): Promise<number | null> {
  try {
    const endpoint = `${resolveApiBaseUrl()}/v1/runs/${encodeURIComponent(runId)}/summary`;
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const value = (body as Record<string, unknown>).droppedTelemetryEventCount;

    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}
