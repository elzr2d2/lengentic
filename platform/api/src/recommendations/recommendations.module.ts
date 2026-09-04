import { Module } from '@nestjs/common';

import { CLOCK, SystemClock } from '../common/clock';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsRepository } from './recommendations.repository';
import { RecommendationsService } from './recommendations.service';

/**
 * §21's recommendation entity, its lifecycle, and the one endpoint §21 specifies.
 *
 * `RecommendationsService` is exported and `RecommendationsRepository` is not: the analysis
 * endpoint (`p5.analysis-endpoint`) needs to record what a run saw, and handing it the
 * repository instead would push the wire mapping and the clock reading into the caller.
 *
 * Reached from `AppModule` through `AnalysisModule`, which imports this module alongside its
 * own `POST /v1/analysis/run` (`23b110d`). Both routes therefore serve HTTP, and
 * `analysis.integration.spec.ts` — "reaches §21 PATCH through the module graph AnalysisModule
 * imports" — is what says so against a real server rather than against this comment.
 *
 * `PrismaService` arrives through the `@Global` `PrismaModule`, which is why nothing is
 * imported here.
 */
@Module({
  controllers: [RecommendationsController],
  providers: [
    RecommendationsService,
    RecommendationsRepository,
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}
