import { z } from 'zod';

import { IdSchema, MetadataSchema, NameSchema } from './primitives';
import { TerminalStatusSchema } from './status';

// metadata is optional and nullable (.nullish()) — see run-events.ts and
// .artifacts/evidence/2/wire-contract-recovery.md S5. parentStepId stays .nullable() only
// (not nullish): null genuinely means "root" and is a distinct, required signal; omitting
// the key is not the same statement and is not asked for here.
export const StepStartedPayloadSchema = z.object({
  name: NameSchema,
  agentName: NameSchema,
  type: NameSchema,
  parentStepId: IdSchema.nullable(),
  metadata: MetadataSchema.nullish(),
});

export const StepCompletedPayloadSchema = z.object({
  status: TerminalStatusSchema,
  metadata: MetadataSchema.nullish(),
});

export type StepStartedPayload = z.infer<typeof StepStartedPayloadSchema>;
export type StepCompletedPayload = z.infer<typeof StepCompletedPayloadSchema>;
