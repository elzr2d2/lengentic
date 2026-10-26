import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import {
  IdSchema,
  RecommendationStatusPatchSchema,
  RecommendationsListQuerySchema,
  type Recommendation,
  type RecommendationListView,
  type RecommendationStatusPatch,
  type RecommendationsListQuery,
  type RepeatedFailedActionListView,
  type RepeatedFailedActionRecommendation,
} from '@lengentic/shared';

import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { RecommendationsService } from './recommendations.service';

/**
 * §21's `PATCH /v1/recommendations/:id/status`. `main.ts` sets the global prefix `v1`, so
 * this controller's own path is `recommendations`.
 *
 * Two routes. §21 specifies the PATCH; the GET is §25 beats 4 and 5's only content path —
 * `evidence`, `minorityContextConcentration`, the attested rate and every counterexample live
 * on the persisted recommendation and nowhere else, and §22's analysis response carries none
 * of them. `RECOMMENDATIONS_PATH` was frozen in `platform/shared` before either lane ran; the
 * route was decided and simply never built, which the 5b wave gate found as a 404 behind the
 * whole Recommendations page.
 *
 * Transport only (`docs/ENGINEERING_STANDARDS.md` API-5): parse, call the service, turn "no
 * such recommendation" into a status code.
 */
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /**
   * `GET /v1/recommendations`. Paginated (API-4), and the query is parsed rather than read:
   * an over-large `limit` is a 400 saying the page would have been short, not a silently
   * clamped page of evidence.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(RecommendationsListQuerySchema)) query: RecommendationsListQuery,
  ): Promise<RecommendationListView | RepeatedFailedActionListView> {
    // `category` defaults to DETERMINISTIC_CANDIDATE (`RecommendationsListQuerySchema`), so a
    // caller that does not name one gets exactly the envelope it was written against.
    return query.category === 'REPEATED_FAILED_ACTION'
      ? this.recommendations.listRepeatedFailedActions(query)
      : this.recommendations.list(query);
  }

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
  ): Promise<Recommendation | RepeatedFailedActionRecommendation> {
    const updated = await this.recommendations.setStatus(id, patch);

    // No id in the message. ERR-4: an API response body carries no internal identifier, and
    // the caller already knows which id it asked for.
    if (updated === undefined) throw new NotFoundException('Recommendation not found');

    return updated;
  }
}
