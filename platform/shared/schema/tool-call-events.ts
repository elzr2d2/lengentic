import { z } from 'zod';

import { IdSchema, NameSchema, TimestampSchema } from './primitives';

/**
 * `tool_call.recorded` — §13's ToolCall. One event after the call finished, like
 * `model_call.recorded`.
 */
export const ToolCallRecordedPayloadSchema = z.object({
  stepId: IdSchema,

  toolName: NameSchema,

  /**
   * Size-capped and redacted client-side (§15). `z.unknown()` rather than MetadataSchema:
   * a tool's input is not necessarily a JSON object — an array or a bare string is a
   * legitimate tool shape. `.nullish()` because "no input" / "no output" must not be a
   * rejection, the same treatment MetadataSchema gets everywhere else.
   */
  input: z.unknown().nullish(),
  output: z.unknown().nullish(),

  /**
   * Required, not defaulted. §15's cap is applied by the SDK, so the SDK is the only party
   * that knows whether it truncated and what the original size was — and `inputBytes` /
   * `outputBytes` are NOT NULL with no default in the Prisma model, so they have nowhere
   * else to come from.
   *
   * Deliberately not `.nullish()` with a false default: an SDK that truncated and omitted
   * the flag would be read as having sent the whole value. Truncation must lose the
   * payload, not the measurement — a silently-false flag loses both.
   */
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),

  /** Client clock (§13). Never combined with a server clock in one duration (§12). */
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),

  /**
   * `error` is null on success. Unbounded string, not NameSchema — an error message is
   * captured evidence, and a bound chosen here would truncate exactly the interesting
   * cases. The event-level byte cap already bounds it.
   */
  success: z.boolean(),
  error: z.string().nullish(),
});

export type ToolCallRecordedPayload = z.infer<typeof ToolCallRecordedPayloadSchema>;
