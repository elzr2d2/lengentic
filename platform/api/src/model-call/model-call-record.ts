import type { Metadata, TelemetryEventOf } from '@lengentic/shared';

/**
 * One `model_call.recorded` event, resolved into §13's ModelCall columns.
 *
 * Unlike Decision, there is exactly one event type behind this table (schema.prisma's own
 * note on the model) — no split between a "recording" writer and an "attestation" writer,
 * so this is the whole write shape, not half of one.
 *
 * A domain shape, not a Prisma one (`CLAUDE.md` ## Types, DATA-1): `model-call.repository.ts`
 * takes this and never a wire event.
 */
export interface ModelCallWrite {
  /** The envelope's `entityId` (§12) — this ModelCall's own id. */
  readonly id: string;

  readonly runId: string;
  readonly stepId: string;

  readonly provider: string;
  readonly model: string;

  readonly latencyMs: number;

  /** Null means the provider reported no usage — §13 marks exactly these two optional. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;

  readonly status: string;

  readonly metadata: Metadata | null;
}

/**
 * Pure, and takes an already-validated event — parsing is `parseTelemetryEvent`'s job at the
 * ingest boundary, and re-validating here would be a second contract that can drift from the
 * first (the same rule `decision-attestation.ts` and `decision-record.ts` follow).
 */
export function toModelCallWrite(event: TelemetryEventOf<'model_call.recorded'>): ModelCallWrite {
  return {
    id: event.entityId,
    runId: event.runId,
    stepId: event.payload.stepId,
    provider: event.payload.provider,
    model: event.payload.model,
    latencyMs: event.payload.latencyMs,
    inputTokens: event.payload.inputTokens ?? null,
    outputTokens: event.payload.outputTokens ?? null,
    status: event.payload.status,
    metadata: event.payload.metadata ?? null,
  };
}
