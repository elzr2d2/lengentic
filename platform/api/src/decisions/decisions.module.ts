import { Module } from '@nestjs/common';
import { DecisionsRepository } from './decisions.repository';
import { DecisionsService } from './decisions.service';

/**
 * §14's attestation capability, as one injectable seam.
 *
 * `DecisionsService` is exported and `DecisionsRepository` is not: an ingest path routing a
 * `decision.outcome_attested` event needs the wire-level entry, and handing it the
 * repository instead would push the two derivations §14 requires (`outcomeAttestedBy` is
 * `CALLER`; an absent `observedAt` means the envelope's `occurredAt`) into the caller.
 *
 * No controller — see `decisions.service.ts`. `PrismaService` arrives through the `@Global`
 * `PrismaModule`, which is why nothing is imported here.
 */
@Module({
  providers: [DecisionsService, DecisionsRepository],
  exports: [DecisionsService],
})
export class DecisionsModule {}
