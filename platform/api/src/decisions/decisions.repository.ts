import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { DecisionAttestation } from './decision-attestation';

/**
 * The Decision table's write side for §14's attestation, and nothing else.
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types): the one public method
 * takes `DecisionAttestation` — a domain shape — and returns nothing. Reads of the Decision
 * table stay where they already are, in `runs.repository.ts`, which owns the run-detail
 * projection; splitting the write out rather than adding it there keeps the attestation path
 * from acquiring the run-scoped list queries as neighbours.
 */
@Injectable()
export class DecisionsRepository {
  constructor(private readonly prisma: PrismaService) {}

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
   * the single statement gives. That is deliberate: the ingest path that will call this owns
   * its own transaction and lock (`telemetry.repository.ts`'s `withEntityLock` does exactly
   * that for Run and Step), and building a second locking apparatus here would presume how
   * that caller — which does not exist yet — will be shaped.
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
