import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  AnalysisRunRequestSchema,
  type AnalysisRunRequest,
  type AnalysisRunResponse,
} from '@lengentic/shared';

import { zodBody } from '../common/zod-validation.pipe';
import { AnalysisService } from './analysis.service';

/**
 * `main.ts` sets the global prefix `v1`, so this controller's own path is `analysis` and the
 * route below is `run` — together, §22's `POST /v1/analysis/run`.
 *
 * The two halves are kept honest by `analysis.controller.spec.ts`, which asserts that
 * `/v1/${CONTROLLER_PATH}/${RUN_ROUTE}` is exactly `ANALYSIS_RUN_PATH` from
 * `@lengentic/shared` — the same constant the Dashboard builds its URL from. A rename on
 * either side then fails a test rather than a demo.
 */
export const CONTROLLER_PATH = 'analysis';
export const RUN_ROUTE = 'run';

/**
 * §22's analysis trigger. One route, and it is a POST.
 *
 * Transport only (`docs/ENGINEERING_STANDARDS.md` API-5): validate the body, call the service,
 * return what it produced. Every §18/§19/§21/§22 rule lives in `AnalysisService` and the
 * mappers beside it, which is where they are tested.
 *
 * `200`, not Nest's default `201` for a POST: nothing here is created *at this URL*. The rows a
 * run may write are `Recommendation` entities addressed elsewhere, and §21's re-analysis rule
 * means a second identical run creates nothing at all — a `201 Created` would assert a creation
 * that did not happen on every re-analysis. `POST /v1/telemetry/events` takes the same reading.
 */
@Controller(CONTROLLER_PATH)
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /**
   * The body carries no parameters (§22: analysis is explicit and on demand, over everything,
   * with the thresholds in force coming from the server's own configuration). Validating
   * against `AnalysisRunRequestSchema` is what makes that a checkable statement rather than an
   * omission — the parameter is bound and unused, so a future parameter has one obvious place
   * to arrive and cannot be read from an unvalidated body.
   */
  @Post(RUN_ROUTE)
  @HttpCode(HttpStatus.OK)
  async run(
    @Body(zodBody(AnalysisRunRequestSchema)) _request: AnalysisRunRequest,
  ): Promise<AnalysisRunResponse> {
    return this.analysis.run();
  }
}
