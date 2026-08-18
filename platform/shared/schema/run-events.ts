import { z } from 'zod';

import { MetadataSchema, NameSchema } from './primitives';
import { TerminalStatusSchema } from './status';

export const RunStartedPayloadSchema = z.object({
  workflowName: NameSchema,
  workflowVersion: NameSchema,
  metadata: MetadataSchema.nullable(),
});

export const RunCompletedPayloadSchema = z.object({
  status: TerminalStatusSchema,
  metadata: MetadataSchema.nullable(),
});

export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;
export type RunCompletedPayload = z.infer<typeof RunCompletedPayloadSchema>;
