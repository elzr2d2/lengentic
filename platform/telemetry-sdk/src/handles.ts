import type {
  DecisionOutcome,
  Metadata,
  TelemetryEventOf,
  TelemetryEventType,
  TerminalStatus,
} from '@lengentic/shared';

import type { PayloadSafety } from './payload-safety';

export interface StartRunInput {
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly metadata?: Metadata | undefined;
}

export interface StartStepInput {
  readonly name: string;
  readonly agentName: string;
  readonly type: string;
  readonly metadata?: Metadata | undefined;
}

export interface CompleteInput {
  /** Defaults to COMPLETED. §12: FAILED wins a terminal-state conflict on the server. */
  readonly status?: TerminalStatus | undefined;
  readonly metadata?: Metadata | undefined;
}

/**
 * §13's ToolCall, as the caller sees it. `inputTruncated`, `outputTruncated`, `inputBytes`
 * and `outputBytes` are deliberately absent: §15's cap is applied by the SDK, so the SDK is
 * the only party that knows whether it truncated and what the original size was
 * (`platform/shared/schema/tool-call-events.ts` says exactly this). A caller that could
 * supply them could contradict them.
 */
export interface RecordToolCallInput {
  readonly toolName: string;
  /** Arbitrary JSON. Sanitized, redacted and capped before transmission (§15). */
  readonly input?: unknown;
  readonly output?: unknown;
  /** Client clock (§13). Never combined with a server clock in one duration (§12). */
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly success: boolean;
  readonly error?: string | undefined;
}

/**
 * §13's ModelCall, as the caller sees it. Reported as one event after the call finished —
 * there is no start/completion pair, which is why this takes a measured `latencyMs` rather
 * than the `startedAt`/`completedAt` pair `RecordToolCallInput` takes: the wire has no
 * timestamps to carry them to (`platform/shared/schema/model-call-events.ts`), and a
 * duration the SDK derived from two Dates the caller supplied would be the same number by a
 * longer route.
 *
 * Token usage lives here and nowhere else. §13: "Do not copy it onto the Decision — a
 * second denominator for the same tokens is how a run's cost gets double-counted."
 */
export interface RecordModelCallInput {
  readonly provider: string;
  readonly model: string;
  /** Client clock (§13). Never combined with a server clock in one duration (§12). */
  readonly latencyMs: number;
  /** §13 marks exactly these two optional. Absent is not zero: a call that reported no
   *  count and a call that consumed none are different facts about a run's cost. */
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** §13 leaves the vocabulary unenumerated and the wire stores a free string; an enum
   *  invented at this layer would reject values the wire never forbade. */
  readonly status: string;
  readonly metadata?: Metadata | undefined;
}

/**
 * §13's Error, as the caller sees it — an error the *instrumented system* reports as
 * telemetry, not an ingestion rejection.
 */
export interface RecordErrorInput {
  readonly type: string;
  /** Free text. Sanitized, redacted and capped before transmission (§15) — see
   *  `PayloadSafety.text` for why a field §15 does not enumerate goes through it anyway. */
  readonly message: string;
  readonly metadata?: Metadata | undefined;
}

/**
 * §13's Decision, as the caller sees it. `outcome`, `outcomeAttestedBy` and
 * `outcomeObservedAt` are deliberately absent: §14 makes attestation an "independent,
 * idempotent telemetry event" because outcomes are usually known later. A decision that
 * could carry its own outcome at record time would invite the caller to guess one.
 */
export interface RecordDecisionInput {
  /** The recurring decision point being analyzed, e.g. `execution_strategy` (§29). */
  readonly decisionType: string;
  /**
   * §14 and docs/decisions/0003: caller-computed, never inferred here. Omitting it is
   * legal and costs aggregation — the decision is stored and excluded from grouping — so
   * the SDK neither defaults it nor rejects the call.
   */
  readonly contextKey?: string | undefined;
  readonly contextKeyVersion?: string | undefined;
  /** Arbitrary JSON, stored alongside the key (§14). Sanitized, redacted and capped (§15). */
  readonly rawContext?: Metadata | undefined;
  readonly availableOptions: readonly string[];
  readonly selectedOption: string;
}

export interface AttestOutcomeInput {
  /**
   * §14's `{ observedAt }`. Client clock, and optional: when it is absent the persistence
   * edge falls back to the envelope's `occurredAt`.
   */
  readonly observedAt?: Date | undefined;
}

/**
 * §14's `telemetry.attestOutcome(decisionId, 'SUCCESS', { observedAt })`, plus the one field
 * that example leaves implicit. `runId` is required because the envelope requires it
 * (`platform/shared/schema/envelope.ts`) and because it is half of the server's idempotency
 * ledger key — an in-process handle knows its own run, a process that starts hours later
 * does not. A caller persisting `decisionId` persists `runId` beside it.
 */
export interface CrossProcessAttestOutcomeInput extends AttestOutcomeInput {
  readonly runId: string;
}

/**
 * §14: "`decision.id` — client-generated, stable, safe to persist". That sentence is this
 * handle's whole reason to exist. A caller persists `decisionId`, and hours or processes
 * later attests the outcome against it.
 */
export interface DecisionHandle {
  readonly decisionId: string;
  readonly stepId: string;
  readonly runId: string;
  /**
   * Same process, later. Not once-only, unlike `complete()`: §14 states re-attesting the
   * same `decisionId` is accepted and last-write-wins, so a corrected outcome is a normal
   * event rather than a mistake to be counted and dropped.
   */
  attestOutcome(outcome: DecisionOutcome, input?: AttestOutcomeInput): void;
}

export interface StepHandle {
  readonly stepId: string;
  readonly runId: string;
  /** A nested step. Its `parentStepId` is this step, resolved structurally. */
  startStep(input: StartStepInput): StepHandle;
  /**
   * Records one finished tool call and returns its `toolCallId` (§12: the envelope's
   * `entityId`). The §15 pipeline runs here, before enqueue — a redacted key never enters
   * the buffer, so it cannot leave the process even if the buffer is later flushed.
   */
  recordToolCall(input: RecordToolCallInput): string;
  /**
   * Records one finished model call and returns its `modelCallId` (§12: the envelope's
   * `entityId`). On this handle rather than the run's because `stepId` is required by the
   * wire — §13 hangs a ModelCall off the Step that made it.
   */
  recordModelCall(input: RecordModelCallInput): string;
  /**
   * Records one error the instrumented system observed and returns its `errorId`. On the
   * step handle for the same reason `recordModelCall` is: the wire requires `stepId`, and
   * "where failures occurred" is a question about a place in the Run tree.
   */
  recordError(input: RecordErrorInput): string;
  /**
   * Records one decision point and returns its handle. The §15 pipeline runs over
   * `rawContext` here, before enqueue, for the same reason it does for tool IO.
   */
  recordDecision(input: RecordDecisionInput): DecisionHandle;
  complete(input?: CompleteInput): void;
}

export interface RunHandle {
  readonly runId: string;
  /** A top-level step: `parentStepId` is null, which §12 reads as "root". */
  startStep(input: StartStepInput): StepHandle;
  complete(input?: CompleteInput): void;
}

/**
 * What a handle needs from the client. Narrow on purpose: handles own the shape of the
 * Run/Step tree and nothing else, and the client owns the queue and the wire.
 */
export interface EventRecorder {
  record<K extends TelemetryEventType>(
    type: K,
    entityId: string,
    runId: string,
    payload: TelemetryEventOf<K>['payload'],
  ): void;
  nextId(): string;
  noteIgnoredCompletion(entityId: string): void;
  /** §15's one shared client-side safe serializer, resolved from config. */
  readonly safety: PayloadSafety;
}

function metadataOf(
  recorder: EventRecorder,
  input: { readonly metadata?: Metadata | undefined },
): {
  metadata?: Metadata;
} {
  // exactOptionalPropertyTypes (TS-8): an explicit `metadata: undefined` is a different
  // statement from an absent key, and the wire contract accepts the absent one.
  //
  // §15 applies to every arbitrary JSON field, and `metadata` is one on four of the event
  // types — so it is sanitized here, in the one place a payload is built, rather than at
  // each call site.
  const safe = recorder.safety.metadata(input.metadata, 'metadata');
  return safe === undefined ? {} : { metadata: safe };
}

function createCompleter(
  recorder: EventRecorder,
  type: 'run.completed' | 'step.completed',
  entityId: string,
  runId: string,
): (input?: CompleteInput) => void {
  let completed = false;
  return (input?: CompleteInput) => {
    if (completed) {
      recorder.noteIgnoredCompletion(entityId);
      return;
    }
    completed = true;
    recorder.record(type, entityId, runId, {
      status: input?.status ?? 'COMPLETED',
      ...metadataOf(recorder, input ?? {}),
    });
  };
}

function createStep(
  recorder: EventRecorder,
  runId: string,
  parentStepId: string | null,
  input: StartStepInput,
): StepHandle {
  const stepId = recorder.nextId();
  recorder.record('step.started', stepId, runId, {
    name: input.name,
    agentName: input.agentName,
    type: input.type,
    parentStepId,
    ...metadataOf(recorder, input),
  });

  return {
    stepId,
    runId,
    startStep: (child) => createStep(recorder, runId, stepId, child),
    recordToolCall: (call) => recordToolCall(recorder, runId, stepId, call),
    recordModelCall: (call) => recordModelCall(recorder, runId, stepId, call),
    recordError: (failure) => recordError(recorder, runId, stepId, failure),
    recordDecision: (decision) => recordDecision(recorder, runId, stepId, decision),
    complete: createCompleter(recorder, 'step.completed', stepId, runId),
  };
}

function recordToolCall(
  recorder: EventRecorder,
  runId: string,
  stepId: string,
  call: RecordToolCallInput,
): string {
  const toolCallId = recorder.nextId();
  // §15's required order, in order: safe serialization → redaction → size cap → enqueue.
  // `toolIO` is the first three; `recorder.record` is the fourth.
  const io = recorder.safety.toolIO(call.input, call.output);
  const durationMs = Math.max(0, call.completedAt.getTime() - call.startedAt.getTime());

  recorder.record('tool_call.recorded', toolCallId, runId, {
    stepId,
    toolName: call.toolName,
    ...io,
    startedAt: call.startedAt.toISOString(),
    completedAt: call.completedAt.toISOString(),
    durationMs,
    success: call.success,
    // S2 (Reviewer, Phase 4 phase gate repair attempt 1; filed `BACKLOG.md` "`tool_call.
    // recorded`'s `error` ships uncapped and unredacted", trigger `p4.sdk-drop-reporting`,
    // landed at `9050756`). `call.error` is caller free text — the same class of value
    // `recordError` below routes through `recorder.safety.text`, and for the same reason
    // that comment gives: `text()` is the only mechanism that can reach a secret embedded in
    // prose, since the shipped redaction defaults match on KEYS, not on value shape.
    ...(call.error === undefined ? {} : { error: recorder.safety.text(call.error, 'error') }),
  });

  return toolCallId;
}

function recordModelCall(
  recorder: EventRecorder,
  runId: string,
  stepId: string,
  call: RecordModelCallInput,
): string {
  const modelCallId = recorder.nextId();

  recorder.record('model_call.recorded', modelCallId, runId, {
    stepId,
    provider: call.provider,
    model: call.model,
    // `latencyMs: z.number().int().nonnegative()`, and the caller supplies it directly — a
    // duration read off `performance.now()` arrives fractional and would cost the whole
    // model call at `checkEnvelope` for a sub-millisecond difference. Same clamp
    // `recordToolCall` applies to `durationMs` one layer down. A non-finite latency is left
    // alone: it is not a measurement, and dropping-with-a-diagnostic is the honest answer.
    latencyMs: Number.isFinite(call.latencyMs) ? Math.max(0, Math.round(call.latencyMs)) : NaN,
    // exactOptionalPropertyTypes (TS-8), and §13's meaning: an absent count is "not
    // reported", which is not the same statement as zero.
    ...(call.inputTokens === undefined ? {} : { inputTokens: call.inputTokens }),
    ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }),
    status: call.status,
    ...metadataOf(recorder, call),
  });

  return modelCallId;
}

function recordError(
  recorder: EventRecorder,
  runId: string,
  stepId: string,
  failure: RecordErrorInput,
): string {
  const errorId = recorder.nextId();
  // §15's order, in order: safe serialization → redaction → size cap → enqueue. `message`
  // is free text the caller controls, so it goes through the one shared sanitizer rather
  // than straight onto the wire — `PayloadSafety.text` records why a field §15 does not
  // enumerate is still routed through it.
  const message = recorder.safety.text(failure.message, 'message');

  recorder.record('error.recorded', errorId, runId, {
    stepId,
    type: failure.type,
    message,
    ...metadataOf(recorder, failure),
  });

  return errorId;
}

function recordDecision(
  recorder: EventRecorder,
  runId: string,
  stepId: string,
  input: RecordDecisionInput,
): DecisionHandle {
  const decisionId = recorder.nextId();
  // §15's order, in order: safe serialization → redaction → size cap → enqueue. `rawContext`
  // is arbitrary caller JSON describing the situation a decision was made in, so it goes
  // through the same one shared sanitizer `metadata` and tool IO do.
  const rawContext = recorder.safety.metadata(input.rawContext, 'rawContext');

  recorder.record('decision.recorded', decisionId, runId, {
    stepId,
    decisionType: input.decisionType,
    // exactOptionalPropertyTypes (TS-8), and more than a type nicety here: §14 draws a hard
    // line between "no contextKey" and any default, so an absent key must stay absent on
    // the wire rather than arriving as an explicit `undefined` some reader coerces.
    ...(input.contextKey === undefined ? {} : { contextKey: input.contextKey }),
    ...(input.contextKeyVersion === undefined
      ? {}
      : { contextKeyVersion: input.contextKeyVersion }),
    ...(rawContext === undefined ? {} : { rawContext }),
    availableOptions: [...input.availableOptions],
    selectedOption: input.selectedOption,
  });

  return {
    decisionId,
    stepId,
    runId,
    attestOutcome: (outcome, attestation) =>
      recordAttestation(recorder, decisionId, runId, outcome, attestation),
  };
}

/**
 * §14's attestation event, keyed on the decision id (the envelope's `entityId`). Shared by
 * the in-process handle and the client-level cross-process form, so the two cannot drift
 * into emitting different events for the same statement.
 */
export function recordAttestation(
  recorder: EventRecorder,
  decisionId: string,
  runId: string,
  outcome: DecisionOutcome,
  input?: AttestOutcomeInput,
): void {
  recorder.record('decision.outcome_attested', decisionId, runId, {
    outcome,
    ...(input?.observedAt === undefined ? {} : { observedAt: input.observedAt.toISOString() }),
  });
}

export function createRun(recorder: EventRecorder, input: StartRunInput): RunHandle {
  const runId = recorder.nextId();
  recorder.record('run.started', runId, runId, {
    workflowName: input.workflowName,
    workflowVersion: input.workflowVersion,
    ...metadataOf(recorder, input),
  });

  return {
    runId,
    startStep: (step) => createStep(recorder, runId, null, step),
    complete: createCompleter(recorder, 'run.completed', runId, runId),
  };
}
