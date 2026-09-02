import { Module } from '@nestjs/common';
import { DecisionsRepository } from './decisions.repository';
import { DecisionsService } from './decisions.service';

/**
 * §13's recording and §14's attestation, as one injectable seam.
 *
 * `DecisionsService` is exported and `DecisionsRepository` is not: `TelemetryModule` (which
 * imports this module to route `decision.recorded` / `decision.outcome_attested` out of an
 * ingest batch) needs the wire-level entry, and handing it the repository instead would push
 * the derivations this module owns (`outcomeAttestedBy` is `CALLER`; an absent `observedAt`
 * means the envelope's `occurredAt`) into the caller.
 *
 * No controller — see `decisions.service.ts`. `PrismaService` arrives through the `@Global`
 * `PrismaModule`, which is why nothing is imported here.
 */
@Module({
  providers: [DecisionsService, DecisionsRepository],
  exports: [DecisionsService],
})
export class DecisionsModule {}
