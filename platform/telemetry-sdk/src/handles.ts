import type {
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
