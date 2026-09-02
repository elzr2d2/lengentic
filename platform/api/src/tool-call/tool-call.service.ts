import { Injectable } from '@nestjs/common';
import type { TelemetryEventOf } from '@lengentic/shared';
import { toToolCallWrite } from './tool-call-record';
import { ToolCallRepository } from './tool-call.repository';

/**
 * §13's `tool_call.recorded` path, server side: the seam `telemetry.service.ts` hands a
 * validated envelope to. Mirrors `DecisionsService.record`.
 */
@Injectable()
export class ToolCallService {
  constructor(private readonly repository: ToolCallRepository) {}

  /**
   * Rejects when the write does. A tool call reported as recorded but dropped on the floor
   * would leave the Run Explorer's Tool Calls view silently short one row, truncation flag
   * and all.
   */
  async record(event: TelemetryEventOf<'tool_call.recorded'>): Promise<void> {
    await this.repository.record(toToolCallWrite(event));
  }
}
