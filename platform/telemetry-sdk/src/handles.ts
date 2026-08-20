import type {
  Metadata,
  TelemetryEventOf,
  TelemetryEventType,
  TerminalStatus,
} from '@lengentic/shared';

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

export interface StepHandle {
  readonly stepId: string;
  readonly runId: string;
  /** A nested step. Its `parentStepId` is this step, resolved structurally. */
  startStep(input: StartStepInput): StepHandle;
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
}

function metadataOf(input: { readonly metadata?: Metadata | undefined }): {
  metadata?: Metadata;
} {
  // exactOptionalPropertyTypes (TS-8): an explicit `metadata: undefined` is a different
  // statement from an absent key, and the wire contract accepts the absent one.
  return input.metadata === undefined ? {} : { metadata: input.metadata };
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
      ...metadataOf(input ?? {}),
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
    ...metadataOf(input),
  });

  return {
    stepId,
    runId,
    startStep: (child) => createStep(recorder, runId, stepId, child),
    complete: createCompleter(recorder, 'step.completed', stepId, runId),
  };
}

export function createRun(recorder: EventRecorder, input: StartRunInput): RunHandle {
  const runId = recorder.nextId();
  recorder.record('run.started', runId, runId, {
    workflowName: input.workflowName,
    workflowVersion: input.workflowVersion,
    ...metadataOf(input),
  });

  return {
    runId,
    startStep: (step) => createStep(recorder, runId, null, step),
    complete: createCompleter(recorder, 'run.completed', runId, runId),
  };
}
