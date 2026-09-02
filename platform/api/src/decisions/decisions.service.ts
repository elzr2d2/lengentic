import { Injectable } from '@nestjs/common';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toDecisionAttestation } from './decision-attestation';
import { toDecisionRecordWrite } from './decision-record';
import { DecisionsRepository } from './decisions.repository';

/**
 * §13's recording and §14's attestation, server side: the seam `telemetry.service.ts` hands
 * a validated `decision.recorded` or `decision.outcome_attested` envelope to.
 *
 * This is the only file in the module that knows what a wire envelope looks like — the
 * repository below it sees a `DecisionRecordWrite` / `DecisionAttestation` and the columns,
 * never a `type`, an `eventId` or a `payload`. That split is what keeps the facts the wire
 * does not carry (`outcomeAttestedBy` is `CALLER`; an absent `observedAt` means the
 * envelope's `occurredAt`) in one place instead of in every caller.
 *
 * There is no controller. Both events are telemetry EVENTS — the SDK's
 * `telemetry.recordDecision(...)` and `telemetry.attestOutcome(decisionId, outcome, { runId })`
 * emit envelopes through the ordinary ingest endpoint — so a decision-specific HTTP route
 * would be a second way in with its own validation, its own idempotency story and no
 * producer.
 */
@Injectable()
export class DecisionsService {
  constructor(private readonly repository: DecisionsRepository) {}

  /**
   * Stores one recorded decision. Rejects when the write does, for the same reason
   * `attestOutcome` below does: a decision reported as recorded but dropped on the floor
   * would leave every reader of that run's Decisions view believing it happened.
   */
  async record(event: TelemetryEventOf<'decision.recorded'>): Promise<void> {
    await this.repository.record(toDecisionRecordWrite(event));
  }

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
