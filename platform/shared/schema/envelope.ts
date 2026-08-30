import { z } from 'zod';

import { IdSchema, TimestampSchema } from './primitives';
import { TelemetryEventTypeSchema } from './event-type';
import { TelemetrySchemaVersionSchema } from './schema-version';

export {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSIONS,
  TelemetrySchemaVersionSchema,
} from './schema-version';
export type { TelemetrySchemaVersion } from './schema-version';

// `schemaVersion` was `z.literal('1')` through Phase 2; it is now the accepted-versions
// enum. §12's rejection reason is unchanged ("unknown or missing schemaVersion") and so is
// its classification in parse.ts — only the set of known versions grew. Which *types* each
// version may carry is `TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION` in ./event-type, checked
// after the envelope parses, because the answer depends on two fields at once and this
// schema decides fields independently.
export const TelemetryEventEnvelopeSchema = z.object({
  eventId: IdSchema,
  schemaVersion: TelemetrySchemaVersionSchema,
  type: TelemetryEventTypeSchema,
  entityId: IdSchema,
  runId: IdSchema,
  occurredAt: TimestampSchema,
  payload: z.unknown(),
});

export type TelemetryEventEnvelope = z.infer<typeof TelemetryEventEnvelopeSchema>;
