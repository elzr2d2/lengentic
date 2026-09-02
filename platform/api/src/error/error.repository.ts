import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { ErrorRecordWrite } from './error-record';

// Recovered structurally from `PrismaClient` itself — same technique every sibling
// repository in this packet uses (`CLAUDE.md` ## Types).
type ErrorJsonInput = Exclude<
  NonNullable<Parameters<PrismaClient['error']['upsert']>[0]['create']>['metadata'],
  undefined
>;

function toJsonInput(value: unknown): ErrorJsonInput {
  return (value === undefined ? null : value) as ErrorJsonInput;
}

/**
 * The Error table's write side. One event, one row — `upsert` is about SDK-retry idempotency
 * (the same `id` replayed after a timeout converges on one row), not about a second writer
 * racing to fill different columns.
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types). Reads stay in
 * `runs.repository.ts`.
 */
@Injectable()
export class ErrorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(write: ErrorRecordWrite): Promise<void> {
    const columns = {
      runId: write.runId,
      stepId: write.stepId,
      type: write.type,
      message: write.message,
      metadata: toJsonInput(write.metadata),
    };

    await this.prisma.client.error.upsert({
      where: { id: write.id },
      create: { id: write.id, ...columns },
      update: columns,
    });
  }
}
