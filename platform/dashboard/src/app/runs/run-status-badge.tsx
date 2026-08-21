import type { RunViewStatus } from '@lengentic/shared/read';

/**
 * The four statuses of `RunViewStatusSchema`, each with its own tone.
 *
 * `STALE` is a state of its own here, not a decoration on `RUNNING`. It is derived
 * server-side from `lastEventAt` and never stored (§13, ADR 0005 decision 4), and it means
 * something operationally different: a `RUNNING` run is expected to send more events, a
 * `STALE` one has stopped and is excluded from historical aggregation. Rendering the two the
 * same way would hide the only signal that a run died without saying so.
 *
 * The switch is exhaustive by rule (ENGINEERING_STANDARDS TS-5), so widening
 * `RUN_VIEW_STATUSES` fails the typecheck here rather than falling through to a default.
 */
export function RunStatusBadge({ status }: { status: RunViewStatus }) {
  return <span className={`status status-${toneFor(status)}`}>{status}</span>;
}

function toneFor(status: RunViewStatus): 'ok' | 'live' | 'warn' | 'down' {
  switch (status) {
    case 'COMPLETED':
      return 'ok';
    case 'RUNNING':
      return 'live';
    case 'STALE':
      return 'warn';
    case 'FAILED':
      return 'down';
  }
}
