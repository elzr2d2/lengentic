import { z } from 'zod';

/**
 * The body of `GET /health` — 200 when every dependency is up, 503 when one is down, the same
 * shape either way.
 *
 * Lives here for the reason `run-view.ts` does: the API produces it and the Dashboard
 * consumes it, `check:boundaries` forbids the Dashboard importing `platform/api/src/**`, and
 * the two hand-written twins this replaces were a second contract waiting to drift
 * (ENGINEERING_STANDARDS TS-9, API-1). The Dashboard `safeParse`s it, because a body from
 * another process is `unknown` until something checks it (SEC-2).
 */
export const CheckStatusSchema = z.enum(['up', 'down']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const HealthReportSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().int().nonnegative(),
  checks: z.object({
    database: CheckStatusSchema,
  }),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;
