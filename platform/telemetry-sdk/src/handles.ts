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
    ...(call.error === undefined ? {} : { error: call.error }),
  });

  return toolCallId;
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
