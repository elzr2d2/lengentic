import type {
  DecisionView,
  ErrorView,
  ModelCallView,
  RunDetailView,
  ToolCallView,
} from '@lengentic/shared/read';

/**
 * The Run Explorer's Phase 4 collections — Decisions, Model Calls, Tool Calls, Errors — and
 * the Ingestion Health reading over them.
 *
 * ## The one distinction this module exists to keep
 *
 * `RunDetailViewSchema` marks all four `.optional()`, and `platform/shared/read/run-view.ts`
 * spends nine lines saying why `.default([])` was rejected: "`undefined` says 'this response
 * did not carry them'; `[]` says 'there are none'. Those are different facts and the contract
 * keeps them apart." **A renderer collapses them by default.** `run.decisions?.length ?? 0`
 * and `(run.decisions ?? []).map(…)` both turn a question the API never answered into the
 * sentence "this run made no decisions", and the resulting page is indistinguishable from a
 * true one.
 *
 * That is not hypothetical here. `entityKindOf` returns `null` for all five Phase 4 event
 * types today, so nothing stores a Decision, a ModelCall, a ToolCall or an Error — recorded in
 * `BACKLOG.md` under "Discovered at the Phase 4 wave 4 gate". Every one of these cards is
 * therefore rendering *absence* right now, and `CLAUDE.md` ## Product claims is the governing
 * rule for what it is allowed to say about it: an empty collection means "not answerable", not
 * "none happened".
 *
 * So the three-state {@link CollectionPresence} is computed once, here, where it can be proven
 * in a node environment, and the cards render from it. A card cannot reach past this module to
 * the raw optional field without the reviewer seeing it.
 *
 * ## Why the health counts are nullable
 *
 * Same rule, one level down. "0 tool inputs truncated" over a response that carried no tool
 * calls is a health report asserting a clean run from a signal that never arrived. Each count
 * is `number | null`, null exactly when its collection is `absent`, so the manufactured zero
 * is unrepresentable rather than merely discouraged.
 *
 * ## What is deliberately NOT here
 *
 * No token totals, no latency sums, no call-count roll-up. §23's summary is
 * `platform/api/src/runs/run-summary.ts` and is served from `GET /v1/runs/:id/summary`; a
 * second implementation over here would be free to disagree with the one the product ships.
 * The missing-token *counts* below are not that aggregate — they measure how lossy the stored
 * telemetry is, which is Ingestion Health's own subject, and they commit to no total.
 */

/**
 * Whether the API answered the question, and what it answered.
 *
 * - `absent` — the field was not on the response. The API did not answer. Reporting this as
 *   "none" invents an observation.
 * - `none` — the field was on the response and was empty. The API answered: none.
 * - `some` — rows.
 */
export type CollectionPresence = 'absent' | 'none' | 'some';

export interface TelemetryCollection<TRow> {
  readonly presence: CollectionPresence;
  /** Empty for both `absent` and `none` — which is why `presence` is not derived from it. */
  readonly rows: readonly TRow[];
}

export interface RunTelemetry {
  readonly decisions: TelemetryCollection<DecisionView>;
  readonly modelCalls: TelemetryCollection<ModelCallView>;
  readonly toolCalls: TelemetryCollection<ToolCallView>;
  readonly errors: TelemetryCollection<ErrorView>;
}

export function readRunTelemetry(run: RunDetailView): RunTelemetry {
  return {
    decisions: collect(run.decisions),
    modelCalls: collect(run.modelCalls),
    toolCalls: collect(run.toolCalls),
    errors: collect(run.errors),
  };
}

function collect<TRow>(rows: readonly TRow[] | undefined): TelemetryCollection<TRow> {
  if (rows === undefined) return { presence: 'absent', rows: [] };

  return { presence: rows.length === 0 ? 'none' : 'some', rows: [...rows] };
}

/**
 * The sentence a card puts where its rows would have been.
 *
 * Two different sentences for the two empty states, not one with a hedge. A card that said
 * "No decisions" for both would be the collapse this module prevents, restored at the last
 * step — and it would read as a finding rather than as a gap in the response.
 */
export function describeCollection(presence: CollectionPresence, plural: string): string {
  switch (presence) {
    case 'absent':
      return `This response did not carry ${plural}. That is not a claim that none occurred — the API did not answer the question.`;
    case 'none':
      return `The API reported no ${plural} for this run.`;
    case 'some':
      return '';
  }
}

/**
 * What a tool call's own client clocks say about themselves.
 *
 * Two independent booleans rather than one verdict, because the two facts are independently
 * observable and a caller can report either without the other. `durationMs` is the client's
 * own measurement and `run-view.ts` is explicit that it "is not recomputed here" — so a
 * process whose clock stepped backwards between the start and completion events arrives with
 * reversed instants and a perfectly positive duration, and neither half may be quietly
 * repaired into agreement with the other.
 *
 * Nothing here compares `durationMs` against the gap between the instants. Doing so would be
 * the Dashboard adjudicating between two measurements the caller made, and it has no basis
 * for a verdict; it reports both and marks each where it is odd on its own terms.
 */
export interface ToolCallClock {
  /** `completedAt` precedes `startedAt`. Both are client instants (§12). */
  readonly instantsReversed: boolean;
  /** The caller reported a negative elapsed time. */
  readonly durationNegative: boolean;
}

export function readToolCallClock(call: ToolCallView): ToolCallClock {
  const startMs = Date.parse(call.startedAt);
  const completedMs = Date.parse(call.completedAt);

  return {
    // `TimestampSchema` has already rejected anything unparseable by the time a value reaches
    // here, and `NaN < NaN` is false — so an impossible instant reads as "not reversed"
    // rather than as an anomaly this page cannot explain.
    instantsReversed: completedMs < startMs,
    durationNegative: call.durationMs < 0,
  };
}

/** One collection's line in the health report: was it answered, and with how many rows. */
export interface CollectionReport {
  readonly label: string;
  readonly presence: CollectionPresence;
  /** Rows carried. `0` for both empty states — `presence` is what separates them. */
  readonly count: number;
}

/**
 * Ingestion Health — `MVP_PLAN_V3.md:1789`, "dropped events, if any".
 *
 * Every count is `number | null` and is null exactly when the collection it measures is
 * `absent`. See the module note: the nullability is the point, not a convenience.
 *
 * `droppedTelemetryEventCount` is deliberately not a field here. `GET /v1/runs/:id` carries
 * no such value in any form, so there is nothing for this function to read and a field that
 * is unconditionally `null` would be a computation pretending to be one. The card states the
 * gap in prose instead, where it can also say why — §16's drop counters are client-side SDK
 * state that no envelope, ingest response or column carries to the platform.
 */
export interface IngestionHealth {
  /** All four collections, in the order the Run Explorer's required-view list names them. */
  readonly collections: readonly CollectionReport[];
  readonly toolInputsTruncated: number | null;
  readonly toolOutputsTruncated: number | null;
  /**
   * The summed **original** size of every truncated payload — `inputBytes` / `outputBytes`
   * are what the SDK measured before §15's cap, not what survived it. This is the quantity
   * the DoD line "a 1MB tool output is truncated and flagged" is about.
   */
  readonly truncatedOriginalBytes: number | null;
  readonly toolCallsWithClockAnomaly: number | null;
  readonly modelCallsMissingInputTokens: number | null;
  readonly modelCallsMissingOutputTokens: number | null;
}

/**
 * `null` (Reviewer S3, Phase 4 phase gate repair attempt 1) only under
 * `captureToolIO: false`, where `inputTruncated`/`outputTruncated` are also always `false`
 * (`payload-safety.ts`'s `toolIO`) — so a call this function is ever called for (one whose
 * truncation flag is `true`) never actually has a `null` measurement. The `?? 0` fallback is
 * therefore unreachable by construction; it exists only so a nullable measurement type
 * checks, not because a truncated call's bytes are ever genuinely unmeasured.
 */
function measuredBytes(bytes: number | null): number {
  return bytes ?? 0;
}

export function assessIngestionHealth(run: RunDetailView): IngestionHealth {
  const telemetry = readRunTelemetry(run);
  const toolCallsAnswered = telemetry.toolCalls.presence !== 'absent';
  const modelCallsAnswered = telemetry.modelCalls.presence !== 'absent';

  let toolInputsTruncated = 0;
  let toolOutputsTruncated = 0;
  let truncatedOriginalBytes = 0;
  let toolCallsWithClockAnomaly = 0;

  for (const call of telemetry.toolCalls.rows) {
    if (call.inputTruncated) {
      toolInputsTruncated += 1;
      truncatedOriginalBytes += measuredBytes(call.inputBytes);
    }

    if (call.outputTruncated) {
      toolOutputsTruncated += 1;
      truncatedOriginalBytes += measuredBytes(call.outputBytes);
    }

    // Once per call, not once per anomaly: the reader is counting calls they cannot trust.
    const clock = readToolCallClock(call);
    if (clock.instantsReversed || clock.durationNegative) toolCallsWithClockAnomaly += 1;
  }

  let modelCallsMissingInputTokens = 0;
  let modelCallsMissingOutputTokens = 0;

  for (const call of telemetry.modelCalls.rows) {
    if (call.inputTokens === null) modelCallsMissingInputTokens += 1;
    if (call.outputTokens === null) modelCallsMissingOutputTokens += 1;
  }

  return {
    collections: [
      report('Decisions', telemetry.decisions),
      report('Model calls', telemetry.modelCalls),
      report('Tool calls', telemetry.toolCalls),
      report('Errors', telemetry.errors),
    ],
    toolInputsTruncated: toolCallsAnswered ? toolInputsTruncated : null,
    toolOutputsTruncated: toolCallsAnswered ? toolOutputsTruncated : null,
    truncatedOriginalBytes: toolCallsAnswered ? truncatedOriginalBytes : null,
    toolCallsWithClockAnomaly: toolCallsAnswered ? toolCallsWithClockAnomaly : null,
    modelCallsMissingInputTokens: modelCallsAnswered ? modelCallsMissingInputTokens : null,
    modelCallsMissingOutputTokens: modelCallsAnswered ? modelCallsMissingOutputTokens : null,
  };
}

function report<TRow>(label: string, collection: TelemetryCollection<TRow>): CollectionReport {
  return { label, presence: collection.presence, count: collection.rows.length };
}

/**
 * A byte count, or the phrase for one that was never reported.
 *
 * `'not reported'` and not `'0 bytes'`, for the same reason every nullable count above is
 * nullable. The digit grouping is done here rather than with `toLocaleString`, which reads
 * the ambient locale and would render `1.048.576` on a European server and `1,048,576` in
 * the test — a rendering that disagrees with its own assertion depending on where it runs.
 */
export function formatByteCount(bytes: number | null): string {
  if (bytes === null) return 'not reported';

  return `${group(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

/**
 * A count, or the phrase for one that was never reported.
 *
 * One function for token counts (§13 marks both optional — a provider that reported no usage
 * is normal) and for the health counts above (null when the collection was never carried),
 * because it is one rule: a count nobody reported is a phrase, never a zero.
 */
export function formatCount(value: number | null): string {
  return value === null ? 'not reported' : group(value);
}

/** Thousands separators, locale-independently. */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
