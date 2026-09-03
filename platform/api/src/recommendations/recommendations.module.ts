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
 * Not yet imported by `AppModule` — `platform/api/src/app.module.ts` is outside this lane's
 * `allowed_paths` and belongs to `p5.analysis-endpoint`, which registers this module
 * alongside its own `POST /v1/analysis/run`. Until then the PATCH route is unrouted: every
 * unit below exists and is tested, and nothing serves HTTP.
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
