import { z } from 'zod';

import { IdSchema, MetadataSchema, NameSchema } from './primitives';

/**
 * `model_call.recorded` — §13's ModelCall, reported as one event after the call finished.
 * There is no start/completion pair, so unlike Run and Step there is no arrival-order
 * hazard and §13's unmarked fields are simply required (p4.entities records the same
 * reasoning on the Prisma model).
 *
 * Token usage lives here and nowhere else. §13: "Do not copy it onto the Decision — a
 * second denominator for the same tokens is how a run's cost gets double-counted."
 */
export const ModelCallRecordedPayloadSchema = z.object({
  stepId: IdSchema,

  provider: NameSchema,
  model: NameSchema,

  latencyMs: z.number().int().nonnegative(),

  /** §13 marks exactly these two optional. */
  inputTokens: z.number().int().nonnegative().nullish(),
  outputTokens: z.number().int().nonnegative().nullish(),

  /**
   * §13 leaves the vocabulary unenumerated and p4.entities stores a free string rather than
   * invent one. The wire matches: an enum guessed here would reject values §13 never
   * forbade, and narrowing later is the reversible direction — widening a shipped enum is
   * not.
   */
  status: NameSchema,

  metadata: MetadataSchema.nullish(),
});

export type ModelCallRecordedPayload = z.infer<typeof ModelCallRecordedPayloadSchema>;
