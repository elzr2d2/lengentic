import { Module } from '@nestjs/common';

import { CLOCK, SystemClock } from '../common/clock';
import { RecommendationsModule } from '../recommendations/recommendations.module';
import { staleThresholdProvider } from '../runs/stale-threshold.provider';
import { analyzerConfigProvider } from './analyzer-config.provider';
import { AnalysisController } from './analysis.controller';
import { AnalysisRepository } from './analysis.repository';
import { AnalysisService } from './analysis.service';

/**
 * §22's `POST /v1/analysis/run`.
 *
 * Imports `RecommendationsModule` for `RecommendationsService` — the seam that module exports
 * for exactly this caller, so the wire mapping and the clock reading for a persisted row stay
 * on its side of the boundary rather than here. `RecommendationsRepository` is deliberately not
 * exported there and is not reached for.
 *
 * `staleThresholdProvider` is re-registered rather than imported from `RunsModule`: it is a
 * value provider over `ConfigService`, both modules need the same `STALE_RUN_THRESHOLD_MS`, and
 * exporting it from `RunsModule` would make the runs feature a dependency of analysis for the
 * sake of one number. `RunsModule` does the same with `CLOCK`.
 *
 * Nothing on the ingest path imports this module. §22's "analysis must not run inline with
 * ingestion" is a property of the module graph, not a comment: `TelemetryModule` has no edge
 * to it, and this module exports nothing for one to be added to.
 *
 * `PrismaService` arrives through the `@Global` `PrismaModule`, which is why it is not imported.
 */
@Module({
  imports: [RecommendationsModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    AnalysisRepository,
    analyzerConfigProvider,
    staleThresholdProvider,
    { provide: CLOCK, useClass: SystemClock },
  ],
})
export class AnalysisModule {}
