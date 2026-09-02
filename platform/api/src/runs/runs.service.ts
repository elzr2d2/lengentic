import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';
import { STALE_THRESHOLD_MS } from './stale-threshold.provider';
import type {
  DecisionRecord,
  ErrorRecord,
  ModelCallRecord,
  RunRecord,
  StepRecord,
  ToolCallRecord,
} from './run-record';
import { RunsRepository } from './runs.repository';
import { aggregateRunSummary, type RunSummary } from './run-summary';
import { deriveRunViewStatus } from './stale';
import type {
  DecisionView,
  ErrorView,
  ModelCallView,
  RunDetailView,
  RunListView,
  RunSummaryView,
  RunsListQuery,
  StepView,
  ToolCallView,
} from '@lengentic/shared/read';

/**
 * Reads runs. The only place the derived/stored status split is resolved.
 *
 * `now` and the threshold arrive as constructor arguments rather than being read from
 * `Date.now()` and `ConfigService` inside the methods. That is what lets the thirty-minute
 * boundary be tested exactly instead of slept through, and it keeps `deriveRunViewStatus` a
 * pure function of its inputs.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly repository: RunsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STALE_THRESHOLD_MS) private readonly staleThresholdMs: number,
  ) {}

  /**
   * One page of runs, newest first.
   *
   * `hasMore` is answered by asking for one row more than the page and reporting whether it
   * came back. The alternative — `COUNT(*)` on every list request — costs a second scan to
   * answer a question the caller only needs a boolean for, and `records.length === limit` is
   * simply wrong on the exact last page.
   */
  async list(query: RunsListQuery): Promise<RunListView> {
    // A single clock reading for the whole page. Reading it per run would let two runs with
    // identical `lastEventAt` land on opposite sides of the threshold within one response.
    //
    // Enforced, not merely asserted here: `runs.service.spec.ts` derives a two-run page under
    // a clock that advances 1ms per reading, so moving this call inside the `map` below turns
    // that page's second row STALE and the test red. It was stated only in this comment until
    // the Phase 2 gate, and the inversion passed 155/155 unit and 40/40 integration tests —
    // every clock double in the tree was constant, which makes the two readings
    // indistinguishable. `test/stale-on-kill/kill-mid-run.integration.spec.ts` rests its whole
    // soundness argument on this property.
    const now = this.clock.now();

    const records = await this.repository.listRuns(query.limit + 1, query.offset);
    const page = records.slice(0, query.limit);

    return {
      runs: page.map((record) => this.toRunSummaryView(record, now)),
      limit: query.limit,
      offset: query.offset,
      hasMore: records.length > query.limit,
    };
  }

  /**
   * One run and everything recorded against it — steps, decisions, model calls, tool calls
   * and errors.
   *
   * `undefined` rather than a thrown 404: whether a missing run is an error is a transport
   * decision, and this service is also the seam a future analysis reader would call.
   *
   * The five collections are always present on the response, `[]` included. The schema makes
   * them optional so that a consumer parsing an older deployment's response keeps the rest of
   * the run (`RunDetailViewSchema`'s note), but this service is not that older deployment —
   * omitting an empty array here would make "this run has no decisions" and "this API does
   * not report decisions" indistinguishable to the one consumer that can tell them apart.
   *
   * Five queries in parallel rather than five awaited in turn: they are independent reads
   * keyed on the same `runId`, and the detail page needs all of them before it renders
   * anything. `Promise.all` also means one failing read rejects the whole response rather
   * than yielding a partially-populated run that reads like a complete one.
   */
  async findById(id: string): Promise<RunDetailView | undefined> {
    const now = this.clock.now();

    const record = await this.repository.findRun(id);
    if (record === undefined) return undefined;

    const [steps, decisions, modelCalls, toolCalls, errors] = await Promise.all([
      this.repository.listSteps(id),
      this.repository.listDecisions(id),
      this.repository.listModelCalls(id),
      this.repository.listToolCalls(id),
      this.repository.listErrors(id),
    ]);

    return {
      ...this.toRunSummaryView(record, now),
      steps: steps.map(toStepView),
      decisions: decisions.map(toDecisionView),
      modelCalls: modelCalls.map(toModelCallView),
      toolCalls: toolCalls.map(toToolCallView),
      errors: errors.map(toErrorView),
    };
  }

  /**
   * §23's metric roll-up for one run. Not `RunSummaryView` — see the name-collision note at
   * the top of `run-summary.ts`.
   *
   * `undefined` for an unknown run, for the same reason `findById` returns it: whether that
   * is a 404 is the controller's decision. The distinction matters more here than there —
   * an unknown run and a run with no model or tool calls both aggregate to all-zeroes, and
   * answering the first with zeroes would report "this run made no model calls" about a run
   * the platform has never heard of.
   *
   * No clock argument: not one §23 field is time-derived. `totalModelLatencyMs` sums a
   * stored client measurement, and a stale run's counts are still its counts.
   */
  async summaryFor(id: string): Promise<RunSummary | undefined> {
    const record = await this.repository.findRun(id);
    if (record === undefined) return undefined;

    const [modelCalls, toolCalls] = await Promise.all([
      this.repository.listModelCallMetrics(id),
      this.repository.listToolCallMetrics(id),
    ]);

    return aggregateRunSummary(record.id, {
      modelCalls,
      toolCalls,
      // ADR 0014 decision 2: the Run row now carries this (folded in from a batch's
      // `droppedSinceLastBatch`), so it is read off `record` rather than hardcoded — the
      // whole reason it was passed explicitly here rather than defaulted inside the
      // aggregation was to keep this the one grep-able site that would need to change.
      droppedTelemetryEventCount: record.droppedTelemetryEventCount,
    });
  }

  private toRunSummaryView(record: RunRecord, now: Date): RunSummaryView {
    return {
      id: record.id,
      traceId: record.traceId,
      workflowName: record.workflowName,
      workflowVersion: record.workflowVersion,
      status: deriveRunViewStatus({
        storedStatus: record.status,
        lastEventAt: record.lastEventAt,
        now,
        staleThresholdMs: this.staleThresholdMs,
      }),
      startedAt: toIsoOrNull(record.startedAt),
      completedAt: toIsoOrNull(record.completedAt),
      receivedAt: record.receivedAt.toISOString(),
      lastEventAt: record.lastEventAt.toISOString(),
      metadata: record.metadata,
    };
  }
}

function toIsoOrNull(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString();
}

/**
 * A Step reports its STORED status — see the note on `StepViewSchema`. There is no clock
 * argument here on purpose: nothing about a step is time-derived, and a parameter that is
 * accepted and ignored is an invitation to derive one later.
 */
function toStepView(record: StepRecord): StepView {
  return {
    id: record.id,
    runId: record.runId,
    parentStepId: record.parentStepId,
    name: record.name,
    agentName: record.agentName,
    type: record.type,
    status: record.status,
    startedAt: toIsoOrNull(record.startedAt),
    completedAt: toIsoOrNull(record.completedAt),
    receivedAt: record.receivedAt.toISOString(),
    metadata: record.metadata,
  };
}

/**
 * Every field is copied across explicitly rather than spread, in all four mappings below.
 *
 * The spread would compile and would also carry any column a future migration adds straight
 * onto the wire — which is how a redacted-at-ingest product leaks the next `Json` column
 * somebody stores. DATA-1's persistence edge is only an edge if something has to be written
 * down to cross it.
 *
 * `availableOptions` is copied into a fresh array: `DecisionRecord` types it
 * `readonly string[]`, and the view's `string[]` would otherwise be the record's own array,
 * mutable through the response object.
 */
function toDecisionView(record: DecisionRecord): DecisionView {
  return {
    id: record.id,
    runId: record.runId,
    stepId: record.stepId,
    decisionType: record.decisionType,
    contextKey: record.contextKey,
    contextKeyVersion: record.contextKeyVersion,
    rawContext: record.rawContext,
    availableOptions: record.availableOptions === null ? null : [...record.availableOptions],
    selectedOption: record.selectedOption,
    outcome: record.outcome,
    outcomeAttestedBy: record.outcomeAttestedBy,
    outcomeObservedAt: toIsoOrNull(record.outcomeObservedAt),
    createdAt: record.createdAt.toISOString(),
  };
}

function toModelCallView(record: ModelCallRecord): ModelCallView {
  return {
    id: record.id,
    runId: record.runId,
    stepId: record.stepId,
    provider: record.provider,
    model: record.model,
    latencyMs: record.latencyMs,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    status: record.status,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * `durationMs` is the caller's stored measurement, passed through untouched.
 *
 * Recomputing it from `completedAt - startedAt` would look tidier and would be wrong twice:
 * it would silently overwrite what the SDK actually measured, and on a client clock that
 * moved backwards mid-call it would produce a negative duration the platform would then be
 * asserting. §12: the client clocks are reported, never reconciled.
 */
function toToolCallView(record: ToolCallRecord): ToolCallView {
  return {
    id: record.id,
    runId: record.runId,
    stepId: record.stepId,
    toolName: record.toolName,
    input: record.input,
    output: record.output,
    inputTruncated: record.inputTruncated,
    outputTruncated: record.outputTruncated,
    inputBytes: record.inputBytes,
    outputBytes: record.outputBytes,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
    durationMs: record.durationMs,
    success: record.success,
    error: record.error,
  };
}

function toErrorView(record: ErrorRecord): ErrorView {
  return {
    id: record.id,
    runId: record.runId,
    stepId: record.stepId,
    type: record.type,
    message: record.message,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  };
}
