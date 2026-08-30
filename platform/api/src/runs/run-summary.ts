/**
 * §23 Run Summary — observability, not a third analyzer.
 *
 * Everything here is aggregated from telemetry that is *already stored*. Nothing is inferred,
 * nothing is estimated, and there is deliberately no cost calculation, price database,
 * provider benchmarking or model routing: §23 puts all four Post-MVP and names the shape it
 * is refusing ("Do not add a Cost Optimizer").
 *
 * **Name collision, on purpose.** `RunSummaryView` in `@lengentic/shared/read` is a *run row*
 * — id, workflow, derived status, instants. `RunSummary` here is §23's *metric roll-up* over
 * one run's ModelCall and ToolCall rows. They share four letters and nothing else; a reader
 * who conflates them will look for `modelCallCount` on a list page and not find it.
 *
 * **Why the type is declared here and not in `platform/shared/read/**`.** Only because this
 * packet may not write there (`p4.run-summary` allowed_paths = `platform/api/src/**`). The
 * read model is the right home — the Dashboard cannot import `platform/api/src/**`
 * (`pnpm check:boundaries`), so §23's DoD line "Dropped-event count is visible in the
 * Dashboard" needs this vocabulary to be shared eventually. Recorded as a deferred item, not
 * silently done by widening a lane boundary.
 *
 * The aggregation is a pure function over projections rather than SQL `SUM`/`COUNT` for one
 * reason that is about evidence, not about taste: this packet may write only under
 * `platform/api/src/**`, so `platform/api/test/**` is closed to it and there is no place to
 * put an integration test. A DB-side aggregate would be code no test in this commit could
 * execute. Every rule below is therefore reachable from a unit test — and the per-run row
 * counts are bounded by one run's own telemetry, not by the table.
 */

/** The ModelCall columns §23 aggregates, and no others. §13 marks exactly the two token
 * fields optional — a provider that reports no usage is normal, not an error. */
export interface ModelCallMetrics {
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** The ToolCall columns §23 aggregates. `success` is the stored column, not a derivation. */
export interface ToolCallMetrics {
  readonly success: boolean;
}

/** What the persistence edge hands the aggregation. */
export interface RunSummaryInput {
  readonly modelCalls: readonly ModelCallMetrics[];
  readonly toolCalls: readonly ToolCallMetrics[];
  /**
   * §16's SDK-side drop counter, if a source for it exists. Today none does, and this is
   * always `null` — see `droppedTelemetryEventCount` below.
   */
  readonly droppedTelemetryEventCount: number | null;
}

export interface RunSummary {
  readonly runId: string;

  /** §23 "Model call count". */
  readonly modelCallCount: number;

  /**
   * §23 "Input tokens" / "Output tokens" — the sum of the counts that were actually
   * reported. A ModelCall whose token field is null contributes nothing and is counted in
   * `modelCallsMissingInputTokens` / `...OutputTokens` instead.
   */
  readonly inputTokens: number;
  readonly outputTokens: number;

  /**
   * How many model calls reported no token count. Not in §23's list, and present for §23's
   * own stated reason: it says the drop count is reported because "a summary computed over
   * silently truncated data is misleading". A token total summed over a mix of reported and
   * unreported calls is exactly that — it reads like the run's usage and is a lower bound.
   * Zero here is what makes `inputTokens` a total rather than a floor.
   */
  readonly modelCallsMissingInputTokens: number;
  readonly modelCallsMissingOutputTokens: number;

  /**
   * §23 "Total model latency" — the sum of each call's own `latencyMs`, which is not the
   * run's wall-clock model time: concurrent calls are counted once each, and the sum can
   * exceed the run's duration. The name says "total", and that is what this is.
   */
  readonly totalModelLatencyMs: number;

  /** §23 "Tool call count" / "Failed tool call count". */
  readonly toolCallCount: number;
  readonly failedToolCallCount: number;

  /**
   * §23 "Dropped telemetry event count", and the one field that cannot be answered yet.
   *
   * §16's drop counters (`droppedOverflow`, `droppedInvalid`, `droppedTooLarge`,
   * `droppedAfterShutdown`, `droppedUndeliverable`) are **client-side state only** — no
   * envelope field, no `IngestResponse` field and no column carries them to the platform, so
   * there is nothing stored to aggregate. Reporting `0` would be the green that lies: "no
   * events were dropped" asserted from the absence of a signal the platform never receives.
   * `null` says what is true — no drop count has been reported for this run.
   */
  readonly droppedTelemetryEventCount: number | null;

  // NO `repeatedFailedActions`. §23 lists it; §20.2's conditions (same runId, same toolName,
  // same sanitized inputFingerprint, three consecutive failures, no success between) are
  // `p5.repeated-failed`'s deliverable in Phase 5, and this packet's contract says to ship
  // that field last. A field computed here against a re-implemented §20.2 would be a second
  // definition of the analyzer, free to disagree with the one the product ships.
}

export function aggregateRunSummary(runId: string, input: RunSummaryInput): RunSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let modelCallsMissingInputTokens = 0;
  let modelCallsMissingOutputTokens = 0;
  let totalModelLatencyMs = 0;

  for (const call of input.modelCalls) {
    totalModelLatencyMs += call.latencyMs;

    if (call.inputTokens === null) modelCallsMissingInputTokens += 1;
    else inputTokens += call.inputTokens;

    if (call.outputTokens === null) modelCallsMissingOutputTokens += 1;
    else outputTokens += call.outputTokens;
  }

  let failedToolCallCount = 0;
  for (const call of input.toolCalls) {
    if (!call.success) failedToolCallCount += 1;
  }

  return {
    runId,
    modelCallCount: input.modelCalls.length,
    inputTokens,
    outputTokens,
    modelCallsMissingInputTokens,
    modelCallsMissingOutputTokens,
    totalModelLatencyMs,
    toolCallCount: input.toolCalls.length,
    failedToolCallCount,
    droppedTelemetryEventCount: input.droppedTelemetryEventCount,
  };
}
