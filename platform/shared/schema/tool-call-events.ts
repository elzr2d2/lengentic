import { z } from 'zod';

import { IdSchema, NameSchema, TimestampSchema } from './primitives';

/**
 * `tool_call.recorded` — §13's ToolCall. One event after the call finished, like
 * `model_call.recorded`.
 */
const ToolCallRecordedPayloadObjectSchema = z.object({
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
   * Narrowed (Reviewer B2 / Tester F3, Phase 4 phase gate repair attempt 2): "absent" means
   * "not captured" and NOTHING ELSE. Attempt 1 made this relaxation unconditional, which
   * re-opened the exact defect it was fixing one layer down — `captureToolIO: false` also
   * makes `inputTruncated`/`outputTruncated` always `false` (`payload-safety.ts`'s
   * `toolIO`), so a call that WAS truncated always has a real byte count to report, and one
   * that reports `inputTruncated: true` with `inputBytes` absent is not "not captured", it
   * is a malformed claim — truncation losing the measurement along with the payload, which
   * is precisely what the comment two paragraphs up says must never happen. The
   * `superRefine` below rejects that combination at the wire, the one place that can still
   * make it a request-level impossibility rather than a downstream rendering problem
   * (`run-telemetry.ts`'s `assessIngestionHealth` carries a second, defensive guard against
   * it too, for data that predates this refinement).
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

/**
 * Reviewer B2 / Tester F3 (Phase 4 phase gate repair attempt 2). `inputBytes`/`outputBytes`
 * absent is a legitimate wire state ("not captured", `captureToolIO: false`) ONLY when the
 * matching truncation flag is also `false`. Attempt 1's `.nullish()` alone let
 * `inputTruncated: true` pair with an absent `inputBytes` through as a valid event — parsed,
 * stored, and read back over `GET /v1/runs/:id` as "1 tool input truncated" beside "0 bytes
 * lost to truncation", a manufactured zero for a quantity the system never received
 * (`CLAUDE.md` ## Product claims). Symmetric for `output*`. This is the one property this
 * object schema cannot express field-by-field — it is a relationship BETWEEN two fields —
 * hence `superRefine` rather than a stricter `.nullish()`.
 */
export const ToolCallRecordedPayloadSchema = ToolCallRecordedPayloadObjectSchema.superRefine(
  (payload, ctx) => {
    if (payload.inputTruncated && payload.inputBytes == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputBytes'],
        message:
          'inputBytes is required when inputTruncated is true — truncation must lose the payload, not the measurement',
      });
    }
    if (payload.outputTruncated && payload.outputBytes == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputBytes'],
        message:
          'outputBytes is required when outputTruncated is true — truncation must lose the payload, not the measurement',
      });
    }
  },
);

export type ToolCallRecordedPayload = z.infer<typeof ToolCallRecordedPayloadSchema>;
