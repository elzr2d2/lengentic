import { z } from 'zod';

import { IdSchema, MetadataSchema, NameSchema } from './primitives';
import { TerminalStatusSchema } from './status';

export const StepStartedPayloadSchema = z.object({
  name: NameSchema,
  agentName: NameSchema,
  type: NameSchema,
  parentStepId: IdSchema.nullable(),
  metadata: MetadataSchema.nullable(),
});

export const StepCompletedPayloadSchema = z.object({
  status: TerminalStatusSchema,
  metadata: MetadataSchema.nullable(),
});

export type StepStartedPayload = z.infer<typeof StepStartedPayloadSchema>;
export type StepCompletedPayload = z.infer<typeof StepCompletedPayloadSchema>;
