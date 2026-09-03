import { Body, Controller, NotFoundException, Param, Patch } from '@nestjs/common';
import {
  IdSchema,
  RecommendationStatusPatchSchema,
  type Recommendation,
  type RecommendationStatusPatch,
} from '@lengentic/shared';

import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { RecommendationsService } from './recommendations.service';

/**
 * §21's `PATCH /v1/recommendations/:id/status`. `main.ts` sets the global prefix `v1`, so
 * this controller's own path is `recommendations`.
 *
 * One route, deliberately. §21 specifies exactly this endpoint on the recommendation
 * resource; the list and detail reads the Dashboard needs are `p5.recs-ui`'s consumers and
 * `p5.analysis-endpoint`'s to expose, and a GET added here speculatively would be a second
 * lane's contract written by this one.
 *
 * Transport only (`docs/ENGINEERING_STANDARDS.md` API-5): parse, call the service, turn "no
 * such recommendation" into a status code.
 */
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /**
   * `IdSchema` on the parameter for the same reason `RunsController` uses it: an over-long id
   * is a malformed identifier and should be a 400, not a query against a `VarChar(128)`
   * column that can only ever miss and would report 404 — telling the caller their id is
   * unknown rather than unusable.
   */
  @Patch(':id/status')
  async setStatus(
    @Param('id', new ZodValidationPipe(IdSchema)) id: string,
    @Body(zodBody(RecommendationStatusPatchSchema)) patch: RecommendationStatusPatch,
  ): Promise<Recommendation> {
    const updated = await this.recommendations.setStatus(id, patch);

    // No id in the message. ERR-4: an API response body carries no internal identifier, and
    // the caller already knows which id it asked for.
    if (updated === undefined) throw new NotFoundException('Recommendation not found');

    return updated;
  }
}
