import type { z } from 'zod';

import type { TelemetryEventType } from './event-type';
import type { TelemetryEventEnvelope } from './envelope';
import { RunStartedPayloadSchema, RunCompletedPayloadSchema } from './run-events';
import { StepStartedPayloadSchema, StepCompletedPayloadSchema } from './step-events';
import {
  DecisionRecordedPayloadSchema,
  DecisionOutcomeAttestedPayloadSchema,
} from './decision-events';
import { ModelCallRecordedPayloadSchema } from './model-call-events';
import { ToolCallRecordedPayloadSchema } from './tool-call-events';
import { ErrorRecordedPayloadSchema } from './error-events';

export const TELEMETRY_PAYLOAD_SCHEMAS = {
  'run.started': RunStartedPayloadSchema,
  'run.completed': RunCompletedPayloadSchema,
  'step.started': StepStartedPayloadSchema,
  'step.completed': StepCompletedPayloadSchema,
  'decision.recorded': DecisionRecordedPayloadSchema,
  'decision.outcome_attested': DecisionOutcomeAttestedPayloadSchema,
  'model_call.recorded': ModelCallRecordedPayloadSchema,
  'tool_call.recorded': ToolCallRecordedPayloadSchema,
  'error.recorded': ErrorRecordedPayloadSchema,
} satisfies Record<TelemetryEventType, z.ZodType>;

export type TelemetryEvent = {
  [K in TelemetryEventType]: Omit<TelemetryEventEnvelope, 'type' | 'payload'> & {
    readonly type: K;
    readonly payload: z.infer<(typeof TELEMETRY_PAYLOAD_SCHEMAS)[K]>;
  };
}[TelemetryEventType];

export type TelemetryEventOf<K extends TelemetryEventType> = Extract<TelemetryEvent, { type: K }>;
