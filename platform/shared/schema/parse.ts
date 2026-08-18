import { IdSchema, TimestampSchema } from './primitives';
import { TELEMETRY_SCHEMA_VERSION } from './envelope';
import { TELEMETRY_EVENT_TYPES, type TelemetryEventType } from './event-type';
import { TELEMETRY_PAYLOAD_SCHEMAS, type TelemetryEvent } from './registry';
import { INGEST_ERROR_CODES, type IngestErrorCode } from './ingest';

export type TelemetryEventParseResult =
  | { readonly ok: true; readonly event: TelemetryEvent }
  | {
      readonly ok: false;
      /** null when the event carried no readable eventId — see IngestResult.eventId sentinel. */
      readonly eventId: string | null;
      readonly code: IngestErrorCode;
      readonly message: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEventId(input: Record<string, unknown>): string | null {
  const parsed = IdSchema.safeParse(input['eventId']);
  return parsed.success ? parsed.data : null;
}

function reject(
  eventId: string | null,
  code: IngestErrorCode,
  message: string,
): TelemetryEventParseResult {
  return { ok: false, eventId, code, message };
}

/**
 * The §12 rejection classifier — the one entry point that answers "is this event valid".
 * Check order is §12's bullet order, verbatim: an event wrong in two ways reports the
 * earlier bullet. This is the only non-arbitrary order available.
 */
export function parseTelemetryEvent(input: unknown): TelemetryEventParseResult {
  // Step 0: not a plain object folds into MISSING_REQUIRED_FIELD — it is literally
  // missing all four required fields. No separate MALFORMED_EVENT code; §12 never
  // authorises one and the remedy is identical.
  if (!isPlainObject(input)) {
    return reject(null, INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD, 'event must be a JSON object');
  }

  const eventId = readEventId(input);

  // Step 1: schemaVersion.
  if (input['schemaVersion'] !== TELEMETRY_SCHEMA_VERSION) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `unsupported schemaVersion: ${JSON.stringify(input['schemaVersion'])}`,
    );
  }

  // Step 2: type.
  const type = input['type'];
  if (typeof type !== 'string' || !TELEMETRY_EVENT_TYPES.includes(type as TelemetryEventType)) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `unknown event type: ${JSON.stringify(type)}`,
    );
  }
  const eventType = type as TelemetryEventType;

  // Step 3: required identity/time fields.
  const idResult = IdSchema.safeParse(input['eventId']);
  if (!idResult.success) {
    return reject(eventId, INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD, 'missing or invalid eventId');
  }
  const entityIdResult = IdSchema.safeParse(input['entityId']);
  if (!entityIdResult.success) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD,
      'missing or invalid entityId',
    );
  }
  const runIdResult = IdSchema.safeParse(input['runId']);
  if (!runIdResult.success) {
    return reject(eventId, INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD, 'missing or invalid runId');
  }
  const occurredAtResult = TimestampSchema.safeParse(input['occurredAt']);
  if (!occurredAtResult.success) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD,
      'missing or invalid occurredAt',
    );
  }

  // Step 4: payload against its registered schema.
  const payloadSchema = TELEMETRY_PAYLOAD_SCHEMAS[eventType];
  const payloadResult = payloadSchema.safeParse(input['payload']);
  if (!payloadResult.success) {
    return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
  }

  // Step 5: envelope/type consistency, type-specific.
  if (
    (eventType === 'run.started' || eventType === 'run.completed') &&
    entityIdResult.data !== runIdResult.data
  ) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.INVALID_PAYLOAD,
      'run event entityId must equal runId',
    );
  }
  if (eventType === 'step.started') {
    const startedPayload = payloadResult.data as { parentStepId: string | null };
    if (startedPayload.parentStepId === entityIdResult.data) {
      return reject(
        eventId,
        INGEST_ERROR_CODES.INVALID_PAYLOAD,
        'step parentStepId must not equal entityId',
      );
    }
  }

  const event = {
    eventId: idResult.data,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    type: eventType,
    entityId: entityIdResult.data,
    runId: runIdResult.data,
    occurredAt: occurredAtResult.data,
    payload: payloadResult.data,
  } as TelemetryEvent;

  return { ok: true, event };
}
