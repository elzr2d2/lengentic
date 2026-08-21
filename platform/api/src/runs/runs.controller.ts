import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { IdSchema } from '@lengentic/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RunsService } from './runs.service';
import {
  RunsListQuerySchema,
  type RunDetailView,
  type RunListView,
  type RunsListQuery,
} from '@lengentic/shared/read';

/**
 * `GET /v1/runs` and `GET /v1/runs/:id`. `main.ts` sets the global prefix `v1`, so this
 * controller's own path is `runs`.
 *
 * Transport only (`docs/ENGINEERING_STANDARDS.md` API-5): parse the query, call the service,
 * turn "no such run" into a status code. The STALE derivation, the paging arithmetic and the
 * row mapping all live in `RunsService`, which is where they are tested.
 */
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(RunsListQuerySchema)) query: RunsListQuery,
  ): Promise<RunListView> {
    return this.runs.list(query);
  }

  /**
   * `IdSchema` is the wire contract's own id bound (1–128 chars). Validating here makes an
   * over-long id a 400 — a malformed identifier, which is what it is — instead of a query
   * against a `VarChar(128)` column that can only ever miss and would report 404, telling the
   * caller their id is unknown rather than unusable.
   */
  @Get(':id')
  async detail(@Param('id', new ZodValidationPipe(IdSchema)) id: string): Promise<RunDetailView> {
    const run = await this.runs.findById(id);

    // No id in the message. ERR-4: an API response body carries no internal identifier, and
    // the caller already knows which id it asked for.
    if (run === undefined) throw new NotFoundException('Run not found');

    return run;
  }
}
