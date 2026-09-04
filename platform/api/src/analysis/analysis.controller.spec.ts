import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_RUN_PATH, type AnalysisRunResponse } from '@lengentic/shared';

import { AnalysisController, CONTROLLER_PATH, RUN_ROUTE } from './analysis.controller';
import type { AnalysisService } from './analysis.service';

/**
 * Seam: the route literals this controller is mounted at, and the one handler with
 * `AnalysisService` faked.
 *
 * The route assertion is the whole reason this file exists. `analysis.controller.ts` already
 * CLAIMED it — "the two halves are kept honest by `analysis.controller.spec.ts`" — and the
 * file did not exist, so renaming `CONTROLLER_PATH` to `'analyses'` passed 375 API tests and
 * 107 dashboard tests and 404ed every request the Dashboard makes (5b wave gate, mutant M21).
 * A described-but-unencoded rule is the shape `eb6a835` removed from §19's reporting rule; a
 * comment asserting the encoding exists is worse still, because a reader has been told not to
 * look.
 *
 * The two halves are genuinely independent: `CONTROLLER_PATH` / `RUN_ROUTE` are literals in
 * `analysis.controller.ts`, `ANALYSIS_RUN_PATH` is a literal in
 * `platform/shared/schema/recommendation.ts`, and the Dashboard builds its URL from the
 * second. Nothing but this assertion makes them agree.
 *
 * The pipes are deliberately not exercised: calling a handler as a plain method skips Nest's
 * pipe chain entirely, so an assertion about a rejected body would pass with the pipe deleted.
 * `AnalysisRunRequestSchema` is tested in `platform/shared/test/contract/recommendation.spec.ts`,
 * and the mounted route is proved in `platform/api/test/analysis.integration.spec.ts`.
 */

const EMPTY: AnalysisRunResponse = { evaluatedGroups: [] };

function controllerOver(analysis: Partial<AnalysisService>): AnalysisController {
  return new AnalysisController(analysis as AnalysisService);
}

describe('AnalysisController — the route it is mounted at', () => {
  it('mounts §22 POST /v1/analysis/run, the exact path the Dashboard posts to', () => {
    // `main.ts` sets the global prefix `v1`; the controller supplies the other two segments.
    expect(`/v1/${CONTROLLER_PATH}/${RUN_ROUTE}`).toBe(ANALYSIS_RUN_PATH);
  });

  it('names §22 path verbatim on both halves, so neither can drift alone', () => {
    // Transcribed from MVP_PLAN_V3.md §22, not read off either module. Without these two, a
    // rename of BOTH literals in step would keep the assertion above green while moving the
    // endpoint out from under every deployed consumer.
    expect(CONTROLLER_PATH).toBe('analysis');
    expect(RUN_ROUTE).toBe('run');
  });
});

describe('AnalysisController.run', () => {
  it('returns what the service produced, unchanged', async () => {
    const controller = controllerOver({ run: () => Promise.resolve(EMPTY) });

    await expect(controller.run({})).resolves.toStrictEqual(EMPTY);
  });

  it('takes no parameters from the body — §22 analysis is over everything', async () => {
    const run = vi.fn(() => Promise.resolve(EMPTY));
    const controller = controllerOver({ run });

    await controller.run({});

    expect(run).toHaveBeenCalledWith();
  });
});
