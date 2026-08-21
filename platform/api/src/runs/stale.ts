import type { RunStatus } from '@lengentic/shared';
import type { RunViewStatus } from '@lengentic/shared/read';

/**
 * Everything the STALE rule reads. All four are inputs, none is ambient:
 *
 * - `now` comes from the injected `Clock`, so the rule is testable at exact boundaries
 *   without sleeping (`docs/ENGINEERING_STANDARDS.md` TEST-1).
 * - `staleThresholdMs` comes from `STALE_RUN_THRESHOLD_MS`, which
 *   `docs/decisions/0005-phase-2-wire-contract-gaps.md` decision 4 requires be *consumed,
 *   not reintroduced*.
 */
export interface RunLiveness {
  /** The status as stored on the row. Never `STALE` — `MVP_PLAN_V3.md:592`. */
  readonly storedStatus: RunStatus;
  /** Server clock, §13. Advanced by every accepted `run.*` event. */
  readonly lastEventAt: Date;
  /** Server clock, read once per request. */
  readonly now: Date;
  readonly staleThresholdMs: number;
}

/**
 * `MVP_PLAN_V3.md:595` — `STALE = status == RUNNING AND now - lastEventAt > STALE_RUN_THRESHOLD`.
 *
 * Derived on every read and written nowhere. ADR 0005 decision 4: the response is a view
 * model, not the row, and the substitution is total — a stale run reports `STALE` in place
 * of `RUNNING` rather than alongside it, because a consumer that reads only `status` must
 * not be able to display a dead run as live.
 *
 * Both clocks in the subtraction are the server's. `MVP_PLAN_V3.md:493` forbids combining a
 * client and a server clock in one duration, and `lastEventAt` is explicitly the server's
 * reading (§13) — which is also why this may not be computed in the browser.
 */
export function deriveRunViewStatus(liveness: RunLiveness): RunViewStatus {
  if (liveness.storedStatus !== 'RUNNING') return liveness.storedStatus;

  const idleMs = liveness.now.getTime() - liveness.lastEventAt.getTime();

  return idleMs > liveness.staleThresholdMs ? 'STALE' : 'RUNNING';
}
