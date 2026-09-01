import type { DecisionOutcome, TelemetryEventOf } from '@lengentic/shared';
import type { OutcomeAttestedBy } from '@lengentic/shared/read';

/**
 * One `decision.outcome_attested` event, resolved into the three columns §14 says an
 * attestation writes — plus the two ids that locate the row.
 *
 * A domain shape, not a Prisma one (`CLAUDE.md` ## Types, DATA-1): `decisions.repository.ts`
 * takes this and never a wire event, so the only file in this module that knows what an
 * envelope looks like is the one below it, and the only file that knows what a column looks
 * like is the repository.
 */
export interface DecisionAttestation {
  /** §14: attestation is "keyed on `decisionId`" — the envelope's `entityId` (§12). */
  readonly decisionId: string;

  /**
   * From the envelope, which always carries one (`TelemetryEventEnvelopeSchema`). It is
   * what makes an attestation-first row storable at all: `Decision.runId` is NOT NULL, and
   * an attestation that arrived before its decision has no other source for it.
   */
  readonly runId: string;

  readonly outcome: DecisionOutcome;

  /**
   * Always `CALLER` on this path — see `toDecisionAttestation`. Typed as the full domain
   * vocabulary rather than the literal because `UNKNOWN` is a real value of this column
   * (the state of a decision nobody has attested); it is simply not a value an *attestation*
   * can produce.
   */
  readonly outcomeAttestedBy: OutcomeAttestedBy;

  /** Never null here: absent on the wire means the envelope's `occurredAt`, resolved below. */
  readonly outcomeObservedAt: Date;
}

/**
 * The persistence edge for §14's attestation event: what the caller sent, plus the two
 * things §14 states that the wire deliberately does not carry.
 *
 * `outcomeAttestedBy` is derived, not read. `schema/decision-events.ts` is explicit that it
 * "is deliberately NOT a wire field: the caller cannot choose it ... the arrival of a
 * `decision.outcome_attested` event is itself the evidence that a caller attested". Putting
 * it on the wire would let a caller send `UNKNOWN` alongside an attestation, which is not a
 * statement the domain has a meaning for. This is also the field that keeps the product
 * claim honest: every surface reading it says "attested success rate", because the caller
 * asserted the outcome and the Platform has no way to verify it.
 *
 * `observedAt` falls back to the envelope's `occurredAt`, which the wire contract names as
 * this edge's job. Absent and explicitly `null` take the same branch — `.nullish()` admits
 * both, and letting the stored instant depend on how a caller spelled "I did not record one"
 * would put a spelling difference into the data.
 *
 * Pure, and takes an already-validated event: parsing is `parseTelemetryEvent`'s job at the
 * ingest boundary, and re-validating here would be a second contract that can drift from the
 * first.
 */
export function toDecisionAttestation(
  event: TelemetryEventOf<'decision.outcome_attested'>,
): DecisionAttestation {
  return {
    decisionId: event.entityId,
    runId: event.runId,
    outcome: event.payload.outcome,
    outcomeAttestedBy: 'CALLER',
    outcomeObservedAt: new Date(event.payload.observedAt ?? event.occurredAt),
  };
}
