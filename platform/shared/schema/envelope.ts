import { z } from 'zod';

import { IdSchema, TimestampSchema } from './primitives';
import { TelemetryEventTypeSchema } from './event-type';

export const TELEMETRY_SCHEMA_VERSION = '1' as const;

export const TelemetryEventEnvelopeSchema = z.object({
  eventId: IdSchema,
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  type: TelemetryEventTypeSchema,
  entityId: IdSchema,
  runId: IdSchema,
  occurredAt: TimestampSchema,
  payload: z.unknown(),
});

export type TelemetryEventEnvelope = z.infer<typeof TelemetryEventEnvelopeSchema>;
