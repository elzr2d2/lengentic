import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { DecisionAttestation } from './decision-attestation';
import type { DecisionRecordWrite } from './decision-record';

// The exact input type Prisma generates for a nullable Json column, recovered structurally
// from `PrismaClient` itself — same technique `telemetry.repository.ts` uses, and for the
// same reason: `@lengentic/database` exports only the client type (CLAUDE.md ## Types), so
// this cannot silently drift from the generated client's own shape.
type DecisionJsonInput = Exclude<
  NonNullable<Parameters<PrismaClient['decision']['upsert']>[0]['create']>['rawContext'],
  undefined
>;

function toJsonInput(value: unknown): DecisionJsonInput {
  return (value === undefined ? null : value) as DecisionJsonInput;
}

/**
 * The Decision table's write side — §14's attestation, and (p4.entity-ingest, ADR 0014)
 * §13's recording. Two independent writers on one row, kept as two methods rather than one
 * because the wire keeps them as two independent event types (§14: "outcomes are usually
 * known later, sometimes after the emitting process has exited").
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types): both public methods take
 * a domain shape and return nothing. Reads of the Decision table stay where they already
 * are, in `runs.repository.ts`, which owns the run-detail projection; splitting the write
 * out rather than adding it there keeps this path from acquiring the run-scoped list
 * queries as neighbours.
 */
@Injectable()
export class DecisionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * §13's recording, symmetric to `attestOutcome` below: `upsert`, keyed on `decisionId`,
   * writing exactly the RECORDING-side columns and none of the three attestation columns
   * (`outcome`, `outcomeAttestedBy`, `outcomeObservedAt`).
   *
   * `create` and `update` share the same column bag on purpose, unlike `attestOutcome` —
   * there is no "recording-first vs recording-second" split here the way there is for
   * attestation-first: every field this event carries is required on the wire
   * (`DecisionRecordedPayloadSchema`), so there is nothing a create-only branch would need
   * that an update should not also be allowed to correct. On `create`, the three attestation
   * columns are left off the payload entirely — the Prisma model's own `@default(UNKNOWN)`
   * (`outcome`, `outcomeAttestedBy`) fills them for a genuinely new row, and `update` never
   * touches them, so an attestation that arrived FIRST (an attestation-first row) is not
   * blanked by a `decision.recorded` event that arrives after it.
   *
   * One statement, no prior read — same reasoning as `attestOutcome`: two concurrent first
   * recordings for one `decisionId` (a duplicate emit, not a legal case but not this
   * method's job to rule out) both see no row and both insert-or-converge without a race
   * window a find-then-write would have.
   */
  async record(write: DecisionRecordWrite): Promise<void> {
    const recorded = {
      runId: write.runId,
      stepId: write.stepId,
      decisionType: write.decisionType,
      contextKey: write.contextKey,
      contextKeyVersion: write.contextKeyVersion,
      rawContext: toJsonInput(write.rawContext),
      availableOptions: toJsonInput(write.availableOptions),
      selectedOption: write.selectedOption,
    };

    await this.prisma.client.decision.upsert({
      where: { id: write.decisionId },
      create: { id: write.decisionId, ...recorded },
      update: recorded,
    });
  }

  /**
   * §14's attestation, in one statement: idempotent on `decisionId`, and accepted whether or
   * not the decision itself has arrived.
   *
   * `upsert` rather than a read followed by a create-or-update. Both branches of §14 fall
   * out of it directly — "an attestation for an **unknown** `decisionId` is accepted and
   * stored, not rejected" is the `create` branch, and "re-attesting the same `decisionId`
   * overwrites `outcome`, `outcomeAttestedBy`, and `outcomeObservedAt` — last write wins" is
   * the `update` branch — and neither leaves a window between deciding and writing, which a
   * find-then-write would: two concurrent first attestations for one `decisionId` would both
   * see no row and both insert.
   *
   * `update` carries exactly the three columns §14 names, and deliberately NOT `create`'s
   * whole column bag (the shape `telemetry.repository.ts`'s `saveRun`/`saveStep` reuse for
   * both branches). An attestation knows nothing about the decision except its id: it
   * carries no `stepId`, `decisionType`, `contextKey` or `selectedOption`, so writing that
   * bag on update would blank a recorded decision. `runId` is create-only for a subtler
   * version of the same reason — it is on the envelope of both events, but a
   * `decision.recorded` event is the authority on which run a decision belongs to, and a
   * late attestation carrying a different one must not silently re-home the row. `create`
   * still needs it: `Decision.runId` is NOT NULL, and an attestation-first row has no other
   * source for it.
   *
   * Nothing here serializes concurrent attestations for the same `decisionId` beyond what
   * the single statement gives, and nothing needs to: `telemetry.service.ts` calls this
   * directly, one event at a time, with no group lock the way Run/Step get from
   * `TelemetryRepository.withEntityLock`. Decision has no read-modify-write fold to race —
   * every write here is a single self-contained upsert — so the extra locking apparatus
   * `withEntityLock` exists for would add nothing this statement does not already give.
   */
  async attestOutcome(attestation: DecisionAttestation): Promise<void> {
    const attested = {
      outcome: attestation.outcome,
      outcomeAttestedBy: attestation.outcomeAttestedBy,
      outcomeObservedAt: attestation.outcomeObservedAt,
    };

    await this.prisma.client.decision.upsert({
      where: { id: attestation.decisionId },
      create: { id: attestation.decisionId, runId: attestation.runId, ...attested },
      update: attested,
    });
  }
}
