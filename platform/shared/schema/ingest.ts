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
