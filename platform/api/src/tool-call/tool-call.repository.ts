import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { ToolCallWrite } from './tool-call-record';

// Recovered structurally from `PrismaClient` itself — same technique every sibling
// repository in this packet uses (`CLAUDE.md` ## Types: `@lengentic/database` exports only
// the client type, so this cannot silently drift from the generated client's shape).
type ToolCallJsonInput = Exclude<
  NonNullable<Parameters<PrismaClient['toolCall']['upsert']>[0]['create']>['input'],
  undefined
>;

/**
 * `value` originates from the wire's `z.unknown()` (`tool-call-events.ts`: "a tool's input
 * is not necessarily a JSON object"), so this is the one place it is asserted into the shape
 * Prisma's generated types require — the same role `telemetry.repository.ts`'s `toJsonInput`
 * plays for Run/Step metadata.
 */
function toJsonInput(value: unknown): ToolCallJsonInput {
  return (value === undefined ? null : value) as ToolCallJsonInput;
}

/**
 * The ToolCall table's write side. One event, one row — `upsert` is about SDK-retry
 * idempotency (the same `id` replayed after a timeout converges on one row), not about a
 * second writer racing to fill different columns.
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types). Reads stay in
 * `runs.repository.ts`.
 */
@Injectable()
export class ToolCallRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(write: ToolCallWrite): Promise<void> {
    const columns = {
      runId: write.runId,
      stepId: write.stepId,
      toolName: write.toolName,
      input: toJsonInput(write.input),
      output: toJsonInput(write.output),
      inputTruncated: write.inputTruncated,
      outputTruncated: write.outputTruncated,
      inputBytes: write.inputBytes,
      outputBytes: write.outputBytes,
      startedAt: write.startedAt,
      completedAt: write.completedAt,
      durationMs: write.durationMs,
      success: write.success,
      error: write.error,
    };

    await this.prisma.client.toolCall.upsert({
      where: { id: write.id },
      create: { id: write.id, ...columns },
      update: columns,
    });
  }
}
