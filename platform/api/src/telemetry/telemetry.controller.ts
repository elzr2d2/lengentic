import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IngestRequestSchema, type IngestRequest, type IngestResponse } from '@lengentic/shared';
import { zodBody } from '../common/zod-validation.pipe';
import { TelemetryService } from './telemetry.service';

/**
 * POST /v1/telemetry/events (§12). `main.ts` sets the global prefix `v1`, so this
 * controller's own path is `telemetry/events`.
 *
 * Batch limits and per-event validation are §12's, enforced upstream of this controller:
 * `events` array shape (min 1, max `INGEST_LIMITS.maxEventsPerBatch`) by `IngestRequestSchema`
 * via `ZodValidationPipe` (a failure here is the request-level HTTP 400 — the whole batch,
 * not one event); request body size and JSON validity by `main.ts`'s body parser
 * configuration, ahead of any Nest routing. Everything event-level (schemaVersion, type,
 * required fields, payload shape, oversized single event) is `TelemetryService`'s job — a
 * malformed event never fails this request, it only fails its own `IngestResult`.
 */
@Controller('telemetry/events')
export class TelemetryEventsController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async ingest(@Body(zodBody(IngestRequestSchema)) body: IngestRequest): Promise<IngestResponse> {
    return this.telemetry.ingest(body.events, body.droppedSinceLastBatch, body.deliveryId);
  }
}
