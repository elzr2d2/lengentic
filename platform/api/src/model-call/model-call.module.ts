import { Module } from '@nestjs/common';
import { ModelCallRepository } from './model-call.repository';
import { ModelCallService } from './model-call.service';

/**
 * §13's `model_call.recorded` capability, as one injectable seam — mirrors `DecisionsModule`.
 *
 * `ModelCallService` is exported and `ModelCallRepository` is not: `TelemetryModule` (which
 * imports this module to route the event out of an ingest batch) needs the wire-level entry
 * only. `PrismaService` arrives through the `@Global` `PrismaModule`, which is why nothing
 * else is imported here.
 */
@Module({
  providers: [ModelCallService, ModelCallRepository],
  exports: [ModelCallService],
})
export class ModelCallModule {}
