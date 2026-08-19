import { z } from 'zod';

import { MetadataSchema, NameSchema } from './primitives';
import { TerminalStatusSchema } from './status';

// metadata is optional and nullable (.nullish()), not required-but-nullable: an SDK that
// omits metadata entirely (the natural thing when there is none) must not be rejected.
// Widening what the contract accepts is backward-compatible and reversible; narrowing it
// later is not — CLAUDE.md prefers the reversible option under uncertainty. See
// .artifacts/evidence/2/wire-contract-recovery.md S5.
export const RunStartedPayloadSchema = z.object({
  workflowName: NameSchema,
  workflowVersion: NameSchema,
  metadata: MetadataSchema.nullish(),
});

export const RunCompletedPayloadSchema = z.object({
  status: TerminalStatusSchema,
  metadata: MetadataSchema.nullish(),
});

export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;
export type RunCompletedPayload = z.infer<typeof RunCompletedPayloadSchema>;
