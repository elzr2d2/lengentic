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

// Batch shape only. Typing `events` as an array of validated events would make one
// malformed event fail the whole array parse and reject the batch — the exact failure
// §12 forbids ("A malformed event never rejects the whole batch") and Phase 2's DoD
// tests (MVP_PLAN_V3.md:1611). Per-event validation happens after the batch is accepted,
// via `parseTelemetryEvent` in `./parse`. Do not "tighten" this to
// `z.array(TelemetryEventEnvelopeSchema)`.
export const IngestRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(INGEST_LIMITS.maxEventsPerBatch),
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
export type IngestResultStatus = z.infer<typeof IngestResultStatusSchema>;
