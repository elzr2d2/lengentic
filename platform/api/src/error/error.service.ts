import { Injectable } from '@nestjs/common';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toErrorRecordWrite } from './error-record';
import { ErrorRepository } from './error.repository';

/**
 * §13's `error.recorded` path, server side: the seam `telemetry.service.ts` hands a
 * validated envelope to. Mirrors `DecisionsService.record`.
 */
@Injectable()
export class ErrorService {
  constructor(private readonly repository: ErrorRepository) {}

  /**
   * Rejects when the write does. An error reported by the instrumented system but dropped on
   * the floor here would leave the Run Explorer's Errors view silently short one failure —
   * exactly the surface the DoD preamble ("where failures occurred") depends on.
   */
  async record(event: TelemetryEventOf<'error.recorded'>): Promise<void> {
    await this.repository.record(toErrorRecordWrite(event));
  }
}
