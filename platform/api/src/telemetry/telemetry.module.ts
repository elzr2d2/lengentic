import { Module } from '@nestjs/common';
import { DecisionsModule } from '../decisions/decisions.module';
import { ModelCallModule } from '../model-call/model-call.module';
import { ToolCallModule } from '../tool-call/tool-call.module';
import { ErrorModule } from '../error/error.module';
import { TelemetryEventsController } from './telemetry.controller';
import { TelemetryRepository } from './telemetry.repository';
import { TelemetryService } from './telemetry.service';

/**
 * ADR 0014 ("ONE NODE, NOT TWO"): the four Phase 4 entity modules are imported HERE, not just
 * registered at `AppModule` — `TelemetryService` is what routes `decision.recorded`,
 * `decision.outcome_attested`, `model_call.recorded`, `tool_call.recorded` and
 * `error.recorded` out of an ingest batch, so it is the one thing in the graph that actually
 * injects their services. Before this packet `DecisionsModule` sat in `AppModule.imports`
 * with nothing consuming it (see the module's own history); it now lives where its consumer
 * is, which is also why `AppModule` no longer names it directly.
 */
@Module({
  controllers: [TelemetryEventsController],
  imports: [DecisionsModule, ModelCallModule, ToolCallModule, ErrorModule],
  providers: [TelemetryService, TelemetryRepository],
})
export class TelemetryModule {}
