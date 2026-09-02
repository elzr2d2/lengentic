import { Injectable } from '@nestjs/common';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toModelCallWrite } from './model-call-record';
import { ModelCallRepository } from './model-call.repository';

/**
 * §13's `model_call.recorded` path, server side: the seam `telemetry.service.ts` hands a
 * validated envelope to. Mirrors `DecisionsService.record` — the only file in this module
 * that knows what a wire envelope looks like.
 */
@Injectable()
export class ModelCallService {
  constructor(private readonly repository: ModelCallRepository) {}

  /**
   * Rejects when the write does. A model call reported as recorded but dropped on the floor
   * would leave §23's token and latency roll-up silently short one call.
   */
  async record(event: TelemetryEventOf<'model_call.recorded'>): Promise<void> {
    await this.repository.record(toModelCallWrite(event));
  }
}
