import type { Metadata, TelemetryEventOf } from '@lengentic/shared';

/**
 * One `error.recorded` event, resolved into §13's Error columns.
 *
 * Named `ErrorRecordWrite`, not `ErrorWrite` or `ErrorRecord` — this module's whole
 * vocabulary sits next to the global `Error` type, and every export here says "Error record"
 * in full rather than leaning on a bare `Error` that would shadow the built-in.
 *
 * A domain shape, not a Prisma one (`CLAUDE.md` ## Types, DATA-1).
 */
export interface ErrorRecordWrite {
  /** The envelope's `entityId` (§12) — this Error's own id. */
  readonly id: string;

  readonly runId: string;
  readonly stepId: string;

  readonly type: string;
  readonly message: string;

  readonly metadata: Metadata | null;
}

/**
 * Pure, and takes an already-validated event — parsing is `parseTelemetryEvent`'s job at the
 * ingest boundary.
 */
export function toErrorRecordWrite(event: TelemetryEventOf<'error.recorded'>): ErrorRecordWrite {
  return {
    id: event.entityId,
    runId: event.runId,
    stepId: event.payload.stepId,
    type: event.payload.type,
    message: event.payload.message,
    metadata: event.payload.metadata ?? null,
  };
}
