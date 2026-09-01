import { Injectable } from '@nestjs/common';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toDecisionAttestation } from './decision-attestation';
import { DecisionsRepository } from './decisions.repository';

/**
 * §14's attestation path, server side: the seam an ingest route hands a validated
 * `decision.outcome_attested` envelope to.
 *
 * This is the only file in the module that knows what a wire envelope looks like — the
 * repository below it sees a `DecisionAttestation` and the columns, never a `type`, an
 * `eventId` or a `payload`. That split is what keeps the two facts §14 states but the wire
 * does not carry (`outcomeAttestedBy` is `CALLER`; an absent `observedAt` means the
 * envelope's `occurredAt`) in one place instead of in every caller.
 *
 * There is no controller. §14's cross-process attestation is a telemetry EVENT — the SDK's
 * `telemetry.attestOutcome(decisionId, outcome, { runId })` emits one envelope through the
 * ordinary ingest endpoint — so an attestation-specific HTTP route would be a second way in
 * with its own validation, its own idempotency story and no producer.
 *
 * Nothing calls this yet. Routing `decision.outcome_attested` out of the ingest batch means
 * changing `platform/api/src/telemetry/**`, which belongs to `p4.wire-decisions` and is
 * forbidden to this lane; `entityKindOf` returns `null` for the type today, so the event is
 * rejected as `EVENT_TYPE_NOT_INGESTIBLE` before it could reach here. That write path is
 * unowned in the graph and recorded in `BACKLOG.md`.
 */
@Injectable()
export class DecisionsService {
  constructor(private readonly repository: DecisionsRepository) {}

  /**
   * Stores one attestation. No prior lookup, no gate on the decision existing: §14 accepts
   * an attestation for an unknown `decisionId`, and the emitting process is often not the
   * one that recorded the decision — sometimes it has already exited.
   *
   * Rejects when the write does. An attestation that was dropped and reported as accepted
   * would leave the caller believing the outcome is on record, and every attested success
   * rate computed afterwards short one observation with nothing to show for it.
   */
  async attestOutcome(event: TelemetryEventOf<'decision.outcome_attested'>): Promise<void> {
    await this.repository.attestOutcome(toDecisionAttestation(event));
  }
}
