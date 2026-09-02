import { Module } from '@nestjs/common';
import { ToolCallRepository } from './tool-call.repository';
import { ToolCallService } from './tool-call.service';

/**
 * §13's `tool_call.recorded` capability, as one injectable seam — mirrors `DecisionsModule`.
 *
 * `ToolCallService` is exported and `ToolCallRepository` is not: `TelemetryModule` needs the
 * wire-level entry only. `PrismaService` arrives through the `@Global` `PrismaModule`.
 */
@Module({
  providers: [ToolCallService, ToolCallRepository],
  exports: [ToolCallService],
})
export class ToolCallModule {}
