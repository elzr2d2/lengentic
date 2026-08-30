import { Injectable } from '@nestjs/common';
import { MetadataSchema, type Metadata } from '@lengentic/shared';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { RunRecord, StepRecord } from './run-record';
import type { ModelCallMetrics, ToolCallMetrics } from './run-summary';

// Row shapes recovered structurally from `PrismaClient` itself, the same technique
// `telemetry.repository.ts` uses and for the same reason: `@lengentic/database` exports only
// the client type, never its models (`platform/database/src/index.ts`), so a column rename
// breaks this file at compile time instead of silently producing a `null` field.
//
// These two types are the ONLY place a Prisma-derived shape appears in the runs module.
// `toRunRecord` / `toStepRecord` below are the persistence edge DATA-1 requires: nothing
// past them has ever seen a row.
type RunRow = NonNullable<Awaited<ReturnType<PrismaClient['run']['findUnique']>>>;
type StepRow = NonNullable<Awaited<ReturnType<PrismaClient['step']['findUnique']>>>;

/**
 * Newest run first, tie-broken on `id`.
 *
 * `receivedAt` alone is not a total order — one ingest request stamps every entity in the
 * batch with a single server-clock reading (`telemetry.service.ts`: "One server clock
 * reading for the whole request"), so runs created by one batch collide exactly. Leaving
 * the tie to Postgres would make page 2 of a list able to repeat or skip a row that page 1
 * already showed, which is the same class of defect ADR 0007 rejects for merges: an answer
 * that depends on physical ordering rather than on the data.
 */
const RUN_LIST_ORDER = [{ receivedAt: 'desc' }, { id: 'desc' }] as const;

/** Oldest step first — the order a reader reconstructs the run in. Same tie-break argument. */
const STEP_LIST_ORDER = [{ receivedAt: 'asc' }, { id: 'asc' }] as const;

/**
 * `metadata` is a `Json?` column, so the database will hand back whatever was written.
 * Ingestion only ever writes a value that already satisfied `MetadataSchema.nullish()` on
 * the wire, so the failure branch is unreachable through the supported path; it is a `null`
 * rather than a throw because a single malformed row from a manual `psql` edit must not take
 * down the whole runs list.
 */
function toMetadata(value: unknown): Metadata | null {
  if (value === null || value === undefined) return null;

  const parsed = MetadataSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    traceId: row.traceId,
    workflowName: row.workflowName,
    workflowVersion: row.workflowVersion,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    receivedAt: row.receivedAt,
    lastEventAt: row.lastEventAt,
    metadata: toMetadata(row.metadata),
  };
}

export function toStepRecord(row: StepRow): StepRecord {
  return {
    id: row.id,
    runId: row.runId,
    parentStepId: row.parentStepId,
    name: row.name,
    agentName: row.agentName,
    type: row.type,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    receivedAt: row.receivedAt,
    metadata: toMetadata(row.metadata),
  };
}

@Injectable()
export class RunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(take: number, skip: number): Promise<RunRecord[]> {
    const rows = await this.prisma.client.run.findMany({
      orderBy: [...RUN_LIST_ORDER],
      take,
      skip,
    });

    return rows.map(toRunRecord);
  }

  async findRun(id: string): Promise<RunRecord | undefined> {
    const row = await this.prisma.client.run.findUnique({ where: { id } });

    return row === null ? undefined : toRunRecord(row);
  }

  /**
   * The §23 aggregation inputs, projected to the columns `run-summary.ts` actually reads.
   *
   * `select` rather than a whole row on purpose. `ToolCall.input` / `.output` are capped-but
   * still-large `Json` columns (§15), and a Run Summary that pulled every tool payload into
   * memory to count booleans would make an observability read the most expensive query in
   * the API. No `orderBy`: every field §23 asks for is order-independent, and imposing one
   * would buy a sort the aggregation cannot observe.
   */
  async listModelCallMetrics(runId: string): Promise<ModelCallMetrics[]> {
    return this.prisma.client.modelCall.findMany({
      where: { runId },
      select: { latencyMs: true, inputTokens: true, outputTokens: true },
    });
  }

  async listToolCallMetrics(runId: string): Promise<ToolCallMetrics[]> {
    return this.prisma.client.toolCall.findMany({
      where: { runId },
      select: { success: true },
    });
  }

  /**
   * Every step of one run, including a step whose `parentStepId` names a step that does not
   * exist. §13 gives `parentStepId` no foreign key precisely so that case is storable, and
   * the Phase 2 Definition of Done requires it to be *renderable* — filtering it out here
   * would delete the orphan the Dashboard has to show.
   */
  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = await this.prisma.client.step.findMany({
      where: { runId },
      orderBy: [...STEP_LIST_ORDER],
    });

    return rows.map(toStepRecord);
  }
}
