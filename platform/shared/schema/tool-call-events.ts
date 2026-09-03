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
   * §15's cap is applied by the SDK, so the SDK is the only party that knows whether it
   * truncated and what the original size was.
   *
   * Deliberately not `.nullish()` with a false default: an SDK that truncated and omitted
   * the flag would be read as having sent the whole value. Truncation must lose the
   * payload, not the measurement — a silently-false flag loses both.
   */
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),

  /**
   * `.nullish()` (Reviewer S3, Phase 4 phase gate repair attempt 1) — NOT required. With
   * `captureToolIO: false` (`payload-safety.ts`), nothing was serialized, so there is no
   * measurement to report; a required field forced the SDK to send `0`, which the Dashboard
   * then rendered as "0 bytes lost to truncation" for a run whose tool IO was never
   * measured at all — `CLAUDE.md` ## Product claims, a never-collected measure reading as a
   * genuine zero. Absent is that "not captured" state; a real `0` (measured, and genuinely
   * empty) still ships as `0` and is unaffected.
   *
   * The Prisma columns (`ToolCall.inputBytes`/`outputBytes`) moved from NOT NULL to
   * nullable in lockstep — see `schema.prisma` and its migration — so this relaxation has
   * somewhere to land at the persistence edge; before that migration the column had "nowhere
   * else to come from" than a required wire field, which is why it started this way.
   */
  inputBytes: z.number().int().nonnegative().nullish(),
  outputBytes: z.number().int().nonnegative().nullish(),

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
