import { z } from 'zod';

import { INGEST_LIMITS } from './limits';

export const TELEMETRY_INGEST_PATH = '/v1/telemetry/events';

export const INGEST_ERROR_CODES = Object.freeze({
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  // docs/decisions/0006-oversized-event-is-an-event-level-rejection.md: §15's 32KB-per-field
  // client cap and OD-2's 64KB-per-event server cap do not compose, so an event over
  // INGEST_LIMITS.maxEventPayloadBytes needs its own rejection reason. Event-level, like the
  // four above — the offending event is REJECTED, the other events in the batch still land.
  // This package owns the constant and the reason; the byte measurement against the
  // serialized event and the actual rejection are `p2.ingest-endpoint`'s (the raw wire bytes
  // are not available once the body has been JSON-parsed into `unknown`, so
  // `parseTelemetryEvent` deliberately does not attempt this check).
  EVENT_TOO_LARGE: 'EVENT_TOO_LARGE',
  // Phase 4. The schemaVersion '2' types (`decision.*`, `model_call.recorded`,
  // `tool_call.recorded`, `error.recorded`) are part of the wire contract — they parse, they
  // are not UNKNOWN_EVENT_TYPE, and an emitter built against v2 is not doing anything wrong.
  // What does not exist yet is their server-side persistence: `merge-rules.ts` folds Run and
  // Step lifecycle state and nothing else, and the Decision / ModelCall / ToolCall / Error
  // tables (p4.entities) have no ingest path until `p4.attestation` lands one.
  //
  // Three answers were available and two of them lie. Routing these types through
  // `entityKindOf`'s Run/Step split writes a decision id into the Step table; accepting and
  // dropping them returns ACCEPTED for an event that was never stored. Both read as working
  // software. This code is the third: the event is REJECTED, event-level, with a reason that
  // says exactly which part of the stack is missing. It is expected to become unreachable —
  // deleting it is what "the persistence landed" looks like.
  EVENT_TYPE_NOT_INGESTIBLE: 'EVENT_TYPE_NOT_INGESTIBLE',
} as const);

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[keyof typeof INGEST_ERROR_CODES];

// §12's rejection split, made machine-readable — before this it existed only as the
// comment above INGEST_ERROR_CODES, so nothing a consumer (or a test) could assert
// against separated "event-level" from "request-level". See ADR 0006 and
// .artifacts/evidence/2/wire-contract-recovery.md S3.
//
// Event-level: the offending event is REJECTED; the rest of the batch still lands.
// Derived from INGEST_ERROR_CODES itself, so this list cannot drift from the codes it
// classifies — including EVENT_TOO_LARGE, which ADR 0006 is explicit is event-level, not
// a request-level HTTP 400 (that implementation would discard the other 499 good events).
export const EVENT_LEVEL_ERROR_CODES = Object.freeze(
  Object.values(INGEST_ERROR_CODES),
) as readonly IngestErrorCode[];

// Request-level: §12:531-534 lists these three by prose only, with no wire constant
// anywhere in the contract — `p2.ingest-endpoint` would otherwise have had to invent
// values outside `platform/shared`, breaking "schema/** is the only wire contract"
// (CLAUDE.md ## Types). The whole batch is rejected (HTTP 400); no event-level results
// are produced.
export const REQUEST_ERROR_CODES = Object.freeze({
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_BATCH: 'INVALID_BATCH',
} as const);

export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[keyof typeof REQUEST_ERROR_CODES];

/**
 * The largest `droppedSinceLastBatch` a request may report: 2^31 - 1, which is exactly what
 * a Postgres `int4` holds and therefore exactly what `Run.droppedTelemetryEventCount`
 * (Prisma `Int?`) holds. Anything above it is not a policy violation, it is unstorable.
 *
 * Deliberately NOT in `INGEST_LIMITS` beside `maxEventsPerBatch`. Those three are tunable
 * policy — someone could reasonably raise `maxEventsPerBatch` to 1000 tomorrow. This is not
 * tunable by anyone: it is a fixed property of the column's type, and the only way to change
 * it is a migration to `BigInt`. The API mirrors the same number as `POSTGRES_INT4_MAX` in
 * `platform/api/src/telemetry/wire-sanitize.ts`, for the same six event-level payload fields
 * this covers at the request level; the two cannot drift, because neither is a choice.
 */
export const MAX_DROPPED_SINCE_LAST_BATCH = 2_147_483_647;

// Batch shape only. Typing `events` as an array of validated events would make one
// malformed event fail the whole array parse and reject the batch — the exact failure
// §12 forbids ("A malformed event never rejects the whole batch") and Phase 2's DoD
// tests (MVP_PLAN_V3.md:1611). Per-event validation happens after the batch is accepted,
// via `parseTelemetryEvent` in `./parse`. Do not "tighten" this to
// `z.array(TelemetryEventEnvelopeSchema)`.
export const IngestRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(INGEST_LIMITS.maxEventsPerBatch),

  /**
   * ADR 0014 decision 2. §16's five drop counters (`droppedOverflow`, `droppedInvalid`,
   * `droppedTooLarge`, `droppedAfterShutdown`, `droppedUndeliverable`) are client-side SDK
   * state with no wire representation before this field — the platform had no way to learn
   * "how many events were dropped since the last flush" at all. This carries their SUM, not
   * the breakdown: a sixth entity and table to preserve the per-reason split was rejected as
   * more machinery than one DoD line (`droppedTelemetryEventCount`) is worth. Anything that
   * needs the reason breakdown still reads the SDK's own `stats()`.
   *
   * `.optional()`, not required or defaulted: an SDK built before this field existed sends a
   * batch with no opinion on drops, and that must read as "not reported" — `null` on
   * `RunSummary.droppedTelemetryEventCount` — never as a silently-manufactured `0`. Folded
   * into a per-run counter column at the persistence edge (`platform/api/src/telemetry/**`),
   * not stored as its own row: `runs.service.ts`'s `summaryFor` already passes
   * `droppedTelemetryEventCount` explicitly rather than defaulting it.
   *
   * `.max(MAX_DROPPED_SINCE_LAST_BATCH)` (R4, repair attempt 2): unbounded, this was the
   * same permanent-poison defect as R1 one layer up. `TelemetryService.ingest` folds this
   * value in LAST, after every event in the batch has already committed, so an over-int4
   * value raised SQLSTATE 22003 out of `incrementDroppedCount` as an HTTP 500 with no
   * per-event results for work that HAD landed — and the identical batch threw again on
   * every retry. It is request-level, a property of the batch and not of any event, so the
   * event-level screen in `wire-sanitize.ts` is not in a position to catch it; the bound
   * belongs here, in the same object and by the same mechanism as its sibling `events`.
   * Rejection, not a clamp: a clamp would store a number the client never reported, and
   * reporting drops honestly is this field's entire reason to exist.
   *
   * Bounding one batch does NOT bound the running total —
   * `TelemetryRepository.incrementDroppedCount` adds into the same column across every batch
   * for a run's whole life, so the addition saturates there. Both halves are needed; neither
   * is sufficient.
   */
  droppedSinceLastBatch: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_DROPPED_SINCE_LAST_BATCH)
    .optional(),
});

export const IngestResultStatusSchema = z.enum(['ACCEPTED', 'DUPLICATE', 'REJECTED'] as const);

export const IngestResultErrorSchema = z.object({
  /** Typed `string`, not IngestErrorCode — a new code must never fail an old SDK's parse. */
  code: z.string(),
  message: z.string(),
});

export const IngestResultSchema = z.object({
  eventId: z.string(),
  status: IngestResultStatusSchema,
  /** Present iff status === 'REJECTED'. */
  error: IngestResultErrorSchema.optional(),
});

export const IngestResponseSchema = z.object({
  batchId: z.string(),
  accepted: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  results: z.array(IngestResultSchema),
});

export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
export type IngestResult = z.infer<typeof IngestResultSchema>;
export type IngestResultError = z.infer<typeof IngestResultErrorSchema>;
export type IngestResultStatus = z.infer<typeof IngestResultStatusSchema>;
