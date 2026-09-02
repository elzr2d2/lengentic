import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MetadataSchema, type Metadata } from '@lengentic/shared';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DecisionRecord,
  ErrorRecord,
  ModelCallRecord,
  RunRecord,
  StepRecord,
  ToolCallRecord,
} from './run-record';
import type { ModelCallMetrics, ToolCallMetrics } from './run-summary';

// Row shapes recovered structurally from `PrismaClient` itself, the same technique
// `telemetry.repository.ts` uses and for the same reason: `@lengentic/database` exports only
// the client type, never its models (`platform/database/src/index.ts`), so a column rename
// breaks this file at compile time instead of silently producing a `null` field.
//
// These types are the ONLY place a Prisma-derived shape appears in the runs module. The
// `to*Record` functions below are the persistence edge DATA-1 requires: nothing past them
// has ever seen a row.
type RunRow = NonNullable<Awaited<ReturnType<PrismaClient['run']['findUnique']>>>;
type StepRow = NonNullable<Awaited<ReturnType<PrismaClient['step']['findUnique']>>>;
type DecisionRow = NonNullable<Awaited<ReturnType<PrismaClient['decision']['findUnique']>>>;
type ModelCallRow = NonNullable<Awaited<ReturnType<PrismaClient['modelCall']['findUnique']>>>;
type ToolCallRow = NonNullable<Awaited<ReturnType<PrismaClient['toolCall']['findUnique']>>>;
type ErrorRow = NonNullable<Awaited<ReturnType<PrismaClient['error']['findUnique']>>>;

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
 * Oldest first, tie-broken on `id`, for the three Phase 4 entities that carry `createdAt`.
 *
 * `createdAt` is `@default(now())` — the DATABASE clock, and the only instant every one of
 * these rows is guaranteed to have. It is used here as an ORDER and never as a duration or
 * as an input to a comparison against a client instant, which is what §12 actually forbids.
 * The `id` tie-break is what makes it total: `now()` inside one transaction is a single
 * reading, so a batch that wrote three decisions gives all three the same `createdAt` and
 * leaving the order to Postgres would let two reads of the same run disagree.
 */
const CREATED_AT_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * ToolCall has no `createdAt` (§13 gives it none, and `schema.prisma` adds none), so the
 * only instant available is the CLIENT's `startedAt`.
 *
 * That is the right one anyway — the Run Explorer's Tool Calls view is a reconstruction of
 * what the agent did, in the order the agent did it. A client clock can move backwards, so
 * this is not a guaranteed causal order; the `id` tie-break makes it a stable one, which is
 * the property a repeatedly-read response needs.
 */
const TOOL_CALL_LIST_ORDER = [{ startedAt: 'asc' }, { id: 'asc' }] as const;

/**
 * `availableOptions` is a `Json?` column holding §13's array of option names.
 *
 * Same treatment as `toMetadata`: a row that does not satisfy the shape becomes `null`
 * rather than a throw, because one malformed row from a manual `psql` edit must not take
 * down a whole run's detail page. `null` here already has a meaning the reader understands —
 * an attestation-first Decision has no options — and the alternative, `[]`, would say "this
 * decision offered no options", which is a different and false claim.
 */
const OptionListSchema = z.array(z.string());

function toOptionList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;

  const parsed = OptionListSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

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
    droppedTelemetryEventCount: row.droppedTelemetryEventCount,
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

export function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    decisionType: row.decisionType,
    contextKey: row.contextKey,
    contextKeyVersion: row.contextKeyVersion,
    rawContext: toMetadata(row.rawContext),
    availableOptions: toOptionList(row.availableOptions),
    selectedOption: row.selectedOption,
    outcome: row.outcome,
    outcomeAttestedBy: row.outcomeAttestedBy,
    outcomeObservedAt: row.outcomeObservedAt,
    createdAt: row.createdAt,
  };
}

export function toModelCallRecord(row: ModelCallRow): ModelCallRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    status: row.status,
    metadata: toMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}

/**
 * `input` and `output` pass through unvalidated, unlike every other `Json` column here.
 *
 * There is nothing to validate them against: the wire types them `z.unknown()` because a
 * tool payload is not necessarily a JSON object, so any schema applied here would reject
 * values ingestion accepted and silently blank them. The truncation flags and byte counts
 * are separate columns and travel with the payload precisely so a reader can tell a small
 * value from a clipped one without inspecting it.
 */
export function toToolCallRecord(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    toolName: row.toolName,
    input: row.input,
    output: row.output,
    inputTruncated: row.inputTruncated,
    outputTruncated: row.outputTruncated,
    inputBytes: row.inputBytes,
    outputBytes: row.outputBytes,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    success: row.success,
    error: row.error,
  };
}

export function toErrorRecord(row: ErrorRow): ErrorRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    type: row.type,
    message: row.message,
    metadata: toMetadata(row.metadata),
    createdAt: row.createdAt,
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

  /**
   * Every Decision of one run, including one whose `stepId` is null or names a step that
   * never arrived.
   *
   * Not filtered on `contextKey`. §14 excludes a keyless decision from AGGREGATION, which is
   * the analysis engine's rule; excluding it from the run's own detail response would hide
   * a decision the agent demonstrably made, and the Run Explorer's Decisions view exists to
   * show the key — including its absence.
   */
  async listDecisions(runId: string): Promise<DecisionRecord[]> {
    const rows = await this.prisma.client.decision.findMany({
      where: { runId },
      orderBy: [...CREATED_AT_ORDER],
    });

    return rows.map(toDecisionRecord);
  }

  async listModelCalls(runId: string): Promise<ModelCallRecord[]> {
    const rows = await this.prisma.client.modelCall.findMany({
      where: { runId },
      orderBy: [...CREATED_AT_ORDER],
    });

    return rows.map(toModelCallRecord);
  }

  /**
   * Whole rows, deliberately — unlike `listToolCallMetrics`, which selects one boolean.
   *
   * The §23 roll-up counts booleans and must not drag every payload into memory for that.
   * This method answers a different question ("show me what the agent sent this tool"), so
   * `input` and `output` are the point rather than the cost. They are bounded: §15 caps each
   * arbitrary JSON field at 32KB client-side and the ingest endpoint enforces a per-event
   * byte limit, so the worst case is one run's tool calls times that cap — not a 4MB blob.
   */
  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    const rows = await this.prisma.client.toolCall.findMany({
      where: { runId },
      orderBy: [...TOOL_CALL_LIST_ORDER],
    });

    return rows.map(toToolCallRecord);
  }

  /**
   * Errors the *instrumented system* reported (§13). Ingestion rejections are not rows and
   * are not here — a caller looking for those wants the ingest response's `errors`.
   */
  async listErrors(runId: string): Promise<ErrorRecord[]> {
    const rows = await this.prisma.client.error.findMany({
      where: { runId },
      orderBy: [...CREATED_AT_ORDER],
    });

    return rows.map(toErrorRecord);
  }
}
