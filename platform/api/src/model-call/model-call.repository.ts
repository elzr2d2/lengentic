import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { ModelCallWrite } from './model-call-record';

// Recovered structurally from `PrismaClient` itself, same technique `decisions.repository.ts`
// and `telemetry.repository.ts` use — `@lengentic/database` exports only the client type
// (`CLAUDE.md` ## Types), so this cannot silently drift from the generated client's shape.
type ModelCallJsonInput = Exclude<
  NonNullable<Parameters<PrismaClient['modelCall']['upsert']>[0]['create']>['metadata'],
  undefined
>;

function toJsonInput(value: unknown): ModelCallJsonInput {
  return (value === undefined ? null : value) as ModelCallJsonInput;
}

/**
 * The ModelCall table's write side. One event, one row, no attestation-style second writer —
 * `upsert` here is about SDK-retry idempotency (the same `id` replayed after a timeout must
 * converge on one row), not about two independent writers racing to fill different columns.
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types): the one public method
 * takes `ModelCallWrite` — a domain shape — and returns nothing. Reads of the ModelCall table
 * stay in `runs.repository.ts`, which owns the run-detail projection and the §23 metric
 * roll-up; splitting the write out keeps this path from acquiring those queries as neighbours.
 */
@Injectable()
export class ModelCallRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(write: ModelCallWrite): Promise<void> {
    const columns = {
      runId: write.runId,
      stepId: write.stepId,
      provider: write.provider,
      model: write.model,
      latencyMs: write.latencyMs,
      inputTokens: write.inputTokens,
      outputTokens: write.outputTokens,
      status: write.status,
      metadata: toJsonInput(write.metadata),
    };

    await this.prisma.client.modelCall.upsert({
      where: { id: write.id },
      create: { id: write.id, ...columns },
      update: columns,
    });
  }
}
