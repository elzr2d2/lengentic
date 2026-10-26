import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PrismaClient } from '@lengentic/database';

import { PrismaService } from '../prisma/prisma.service';
import type { AnalysisDecisionSource } from './analysis-source';
import type { AnalysisToolCallSource } from './repeated-failed-source';

// Row shapes recovered structurally from `PrismaClient` itself — the same technique
// `runs.repository.ts`, `decisions.repository.ts` and `recommendations.repository.ts` use, and
// for the same reason: `@lengentic/database` exports only the client type (`CLAUDE.md`
// ## Types), so a column rename breaks this file at compile time instead of silently producing
// a `null` field.
type DecisionRow = NonNullable<Awaited<ReturnType<PrismaClient['decision']['findUnique']>>>;
type RunRow = NonNullable<Awaited<ReturnType<PrismaClient['run']['findUnique']>>>;

/** Exactly the `Run` columns §18's group key and §39's STALE rule need. */
type RunAnalysisProjection = Pick<
  RunRow,
  'id' | 'workflowName' | 'workflowVersion' | 'status' | 'lastEventAt'
>;

/**
 * Exactly the `Decision` columns §18 aggregates over. `rawContext` is absent on purpose: it is
 * a size-capped but still large `Json` column (§15) that no gate reads, and a full recomputation
 * that dragged every one of them into memory would make analysis the most expensive query in
 * the API for a value it never looks at.
 */
type DecisionAnalysisProjection = Pick<
  DecisionRow,
  | 'id'
  | 'runId'
  | 'decisionType'
  | 'contextKey'
  | 'contextKeyVersion'
  | 'availableOptions'
  | 'selectedOption'
  | 'outcome'
  | 'outcomeAttestedBy'
  | 'createdAt'
>;

/**
 * Oldest first, tie-broken on `id` — the same total order `runs.repository.ts` uses for the
 * three Phase 4 entities that carry `createdAt`.
 *
 * Aggregation itself is order-independent (`aggregateAll` sorts its groups by serialized key),
 * so this order buys one thing: two analysis runs over an unchanged database read the same rows
 * in the same sequence, which is what makes a re-run comparable. `createdAt` is
 * `@default(now())` — one reading per transaction — so a batch that wrote three decisions gives
 * all three the same value, and without the `id` tie-break Postgres would be free to order them
 * differently on each read.
 */
const DECISION_ANALYSIS_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * `availableOptions` is a `Json?` column holding §13's array of option names.
 *
 * An unreadable value becomes `[]` rather than a throw, the degraded reading
 * `runs.repository.ts` already takes for this column. It is safe *here* specifically because
 * §18's aggregation never reads `availableOptions` — dominance is computed over
 * `selectedOption` — so the field cannot change a gate result, a distribution or a
 * counterexample. It is carried at all because the engine's `DecisionRecord` declares it.
 */
const OptionListSchema = z.array(z.string());

function toOptionList(value: unknown): readonly string[] {
  const parsed = OptionListSchema.safeParse(value);

  return parsed.success ? parsed.data : [];
}

/**
 * The persistence edge for the analysis read (`docs/ENGINEERING_STANDARDS.md` DATA-1): a
 * `Decision` row and its `Run`'s three analysis columns, mapped explicitly into the domain
 * shape. No Prisma type crosses outward.
 */
export function toAnalysisDecisionSource(
  row: DecisionAnalysisProjection,
  run: RunAnalysisProjection | undefined,
): AnalysisDecisionSource {
  return {
    decisionId: row.id,
    runId: row.runId,
    // A decision whose run row has not arrived is treated as belonging to a live run: STALE is
    // "RUNNING and idle past the threshold" (ADR 0005 decision 4), and a run with no row has
    // no `lastEventAt` to be idle since. It is excluded anyway — `workflowName` is `null`
    // below, so the record has no §18 group key — and this keeps that exclusion attributable
    // to the missing workflow rather than to a fabricated idle time.
    runStatus: run?.status ?? 'RUNNING',
    runLastEventAt: run?.lastEventAt ?? row.createdAt,
    workflowName: run?.workflowName ?? null,
    workflowVersion: run?.workflowVersion ?? null,
    decisionType: row.decisionType,
    contextKey: row.contextKey,
    contextKeyVersion: row.contextKeyVersion,
    availableOptions: toOptionList(row.availableOptions),
    selectedOption: row.selectedOption,
    outcome: row.outcome,
    outcomeAttestedBy: row.outcomeAttestedBy,
    createdAt: row.createdAt,
  };
}

/**
 * The read side of §22's analysis run: every `Decision` ever recorded, joined to the `Run`
 * columns its group key needs.
 *
 * Read-only, and deliberately its own repository rather than a method on
 * `runs.repository.ts`: that file owns the run-scoped detail projection and every query in it
 * is `where: { runId }`. This one is cross-run by definition — §18 aggregates a decision type
 * across every run that ever made it — and adding it there would hand the run-detail path a
 * query with no run.
 */
@Injectable()
export class AnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every decision, with its run's workflow identity and liveness.
   *
   * Two statements and an in-memory join, not one query: `Decision` has no foreign key to
   * `Run` (`schema.prisma` — a decision event may legitimately arrive before its run's start
   * event), so there is no Prisma relation to `include`. Joining in memory is also what lets a
   * decision whose run row has not arrived survive the read as an explicitly un-grouped row
   * rather than vanish into an inner join.
   *
   * Unbounded, and that is §22: analysis is a full recomputation from the beginning of
   * history, explicit and on demand, with no incremental job and no job table. `select`
   * narrows both statements to the columns the analysis actually reads, so the cost is the row
   * count rather than the payload columns — `Decision.rawContext` in particular is a
   * size-capped but still large `Json` column (§15) that no gate looks at.
   */
  async listDecisionsForAnalysis(): Promise<AnalysisDecisionSource[]> {
    const rows = await this.prisma.client.decision.findMany({
      select: {
        id: true,
        runId: true,
        decisionType: true,
        contextKey: true,
        contextKeyVersion: true,
        availableOptions: true,
        selectedOption: true,
        outcome: true,
        outcomeAttestedBy: true,
        createdAt: true,
      },
      orderBy: [...DECISION_ANALYSIS_ORDER],
    });

    const runIds = [...new Set(rows.map((row) => row.runId))];

    const runs = await this.prisma.client.run.findMany({
      where: { id: { in: runIds } },
      select: {
        id: true,
        workflowName: true,
        workflowVersion: true,
        status: true,
        lastEventAt: true,
      },
    });

    const runsById = new Map(runs.map((run) => [run.id, run]));

    return rows.map((row) => toAnalysisDecisionSource(row, runsById.get(row.runId)));
  }

  /**
   * Every `ToolCall`, narrowed to the columns §20.2 reads. `input` and `output` are NOT
   * selected: the analyzer never sees raw tool IO (`analysis-engine/src/tool-call.ts`), and the
   * most direct way to guarantee that is to never load it.
   *
   * Oldest first by the client clock, tie-broken on `id` — the same reproducibility argument as
   * `DECISION_ANALYSIS_ORDER`, and here the order is also semantically load-bearing: attempts
   * are ordered by `occurredAt`, so two calls sharing a millisecond need a deterministic order
   * or "consecutive" could differ between two reads of unchanged data.
   */
  async listToolCallsForAnalysis(): Promise<AnalysisToolCallSource[]> {
    const rows = await this.prisma.client.toolCall.findMany({
      select: {
        id: true,
        runId: true,
        toolName: true,
        inputFingerprint: true,
        success: true,
        error: true,
        startedAt: true,
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => ({
      toolCallId: row.id,
      runId: row.runId,
      toolName: row.toolName,
      inputFingerprint: row.inputFingerprint,
      success: row.success,
      error: row.error,
      startedAt: row.startedAt,
    }));
  }
}
