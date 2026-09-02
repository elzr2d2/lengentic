import type { Metadata, TelemetryEventOf } from '@lengentic/shared';

/**
 * One `decision.recorded` event, resolved into the columns §13/§14 say the RECORDING side
 * writes — everything except the three attestation columns `decision-attestation.ts` owns.
 *
 * A domain shape, not a Prisma one (`CLAUDE.md` ## Types, DATA-1): `decisions.repository.ts`
 * takes this and never a wire event, mirroring `DecisionAttestation`'s split — the only file
 * in this module that knows what an envelope looks like is the one below it.
 */
export interface DecisionRecordWrite {
  /** §14: the envelope's `entityId` (§12) — the same id an attestation is later keyed on. */
  readonly decisionId: string;

  /** From the envelope. `Decision.runId` is NOT NULL; a recorded decision always has one. */
  readonly runId: string;

  readonly stepId: string;

  /** The recurring decision point being analyzed, e.g. `execution_strategy` (§29). */
  readonly decisionType: string;

  /**
   * §14/docs/decisions/0003: caller-supplied, caller-computed. `null` means the caller
   * supplied none — stored but excluded from aggregation, never defaulted to a shared key.
   */
  readonly contextKey: string | null;
  readonly contextKeyVersion: string | null;

  /** Size-capped and redacted client-side (§15); stored as-is. */
  readonly rawContext: Metadata | null;

  readonly availableOptions: readonly string[];
  readonly selectedOption: string;
}

/**
 * Pure, and takes an already-validated event: parsing is `parseTelemetryEvent`'s job at the
 * ingest boundary, and re-validating here would be a second contract that can drift from the
 * first — the same rule `toDecisionAttestation` follows.
 */
export function toDecisionRecordWrite(
  event: TelemetryEventOf<'decision.recorded'>,
): DecisionRecordWrite {
  return {
    decisionId: event.entityId,
    runId: event.runId,
    stepId: event.payload.stepId,
    decisionType: event.payload.decisionType,
    contextKey: event.payload.contextKey ?? null,
    contextKeyVersion: event.payload.contextKeyVersion ?? null,
    rawContext: event.payload.rawContext ?? null,
    availableOptions: event.payload.availableOptions,
    selectedOption: event.payload.selectedOption,
  };
}
