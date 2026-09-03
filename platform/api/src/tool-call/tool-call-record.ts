import type { TelemetryEventOf } from '@lengentic/shared';

/**
 * One `tool_call.recorded` event, resolved into §13's ToolCall columns.
 *
 * A domain shape, not a Prisma one (`CLAUDE.md` ## Types, DATA-1). `input`/`output` stay
 * `unknown` all the way through, matching `runs.repository.ts`'s `toToolCallRecord`: a tool
 * payload is not necessarily a JSON object, so there is nothing to validate them against
 * beyond what the wire already checked.
 */
export interface ToolCallWrite {
  /** The envelope's `entityId` (§12) — this ToolCall's own id. */
  readonly id: string;

  readonly runId: string;
  readonly stepId: string;

  readonly toolName: string;

  readonly input: unknown;
  readonly output: unknown;

  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
  /**
   * `null` (Reviewer S3, Phase 4 phase gate repair attempt 1) means `captureToolIO: false` —
   * nothing was measured, distinct from a real, reported `0`. `ToolCallRecordedPayloadSchema`
   * carries the same absent/measured distinction as `.nullish()`; `??` collapses an absent
   * wire value the same way a `null` one is already handled, since the domain shape has no
   * use for the difference between "omitted" and "explicitly null".
   */
  readonly inputBytes: number | null;
  readonly outputBytes: number | null;

  /** Client clock (§13). Never combined with a server clock in one duration calculation. */
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly durationMs: number;

  readonly success: boolean;
  readonly error: string | null;
}

/**
 * Pure, and takes an already-validated event — parsing is `parseTelemetryEvent`'s job at the
 * ingest boundary.
 */
export function toToolCallWrite(event: TelemetryEventOf<'tool_call.recorded'>): ToolCallWrite {
  return {
    id: event.entityId,
    runId: event.runId,
    stepId: event.payload.stepId,
    toolName: event.payload.toolName,
    input: event.payload.input ?? null,
    output: event.payload.output ?? null,
    inputTruncated: event.payload.inputTruncated,
    outputTruncated: event.payload.outputTruncated,
    inputBytes: event.payload.inputBytes ?? null,
    outputBytes: event.payload.outputBytes ?? null,
    startedAt: new Date(event.payload.startedAt),
    completedAt: new Date(event.payload.completedAt),
    durationMs: event.payload.durationMs,
    success: event.payload.success,
    error: event.payload.error ?? null,
  };
}
