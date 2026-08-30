import { z } from 'zod';

import { IdSchema, MetadataSchema, NameSchema } from './primitives';

/**
 * `error.recorded` — §13's Error entity.
 *
 * Note this is an error the *instrumented system* reports as telemetry, not an ingestion
 * rejection. Rejections are `INGEST_ERROR_CODES` in `./ingest` and never become rows.
 */
export const ErrorRecordedPayloadSchema = z.object({
  stepId: IdSchema,

  type: NameSchema,

  /**
   * Unbounded, matching the Prisma column ("an error message is captured evidence, and
   * truncating evidence at an arbitrary column bound loses exactly the interesting
   * cases"). Not `.min(1)`: an empty message is uninformative but it is not malformed, and
   * rejecting the event would discard the `type` and `stepId` that still locate the failure.
   */
  message: z.string(),

  metadata: MetadataSchema.nullish(),
});

export type ErrorRecordedPayload = z.infer<typeof ErrorRecordedPayloadSchema>;
