import {
  INGEST_LIMITS,
  TELEMETRY_PAYLOAD_SCHEMAS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
  type TelemetryEventOf,
  type TelemetryEventType,
} from '@lengentic/shared';

import { describeError } from './diagnostics';

const encoder = new TextEncoder();

export interface EnvelopeInput<K extends TelemetryEventType> {
  readonly eventId: string;
  readonly type: K;
  readonly entityId: string;
  readonly runId: string;
  readonly occurredAt: Date;
  readonly payload: TelemetryEventOf<K>['payload'];
}

export function buildEnvelope<K extends TelemetryEventType>(
  input: EnvelopeInput<K>,
): TelemetryEventEnvelope {
  return {
    eventId: input.eventId,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    type: input.type,
    entityId: input.entityId,
    runId: input.runId,
    occurredAt: input.occurredAt.toISOString(),
    payload: input.payload,
  };
}

export type EnvelopeCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'event_invalid' | 'event_too_large';
      readonly reason: string;
    };

/**
 * The client-side gate. Three failures §16 says a record method must survive without
 * throwing — a payload off the wire contract, data that cannot be serialized (circular
 * references, BigInt, a getter that throws), and an event over §12's per-event cap — are
 * all turned into a reason here, at the point the caller can still be told about it, and
 * before the event can poison a batch of 99 good ones on the far side.
 */
export function checkEnvelope(envelope: TelemetryEventEnvelope): EnvelopeCheck {
  const parsed = TelemetryEventEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'event_invalid',
      reason: `envelope rejected: ${parsed.error.message}`,
    };
  }

  const payload = TELEMETRY_PAYLOAD_SCHEMAS[parsed.data.type].safeParse(envelope.payload);
  if (!payload.success) {
    return {
      ok: false,
      code: 'event_invalid',
      reason: `payload rejected for ${parsed.data.type}: ${payload.error.message}`,
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch (error) {
    return {
      ok: false,
      code: 'event_invalid',
      reason: `not serializable: ${describeError(error)}`,
    };
  }
  const bytes = encoder.encode(serialized).length;
  if (bytes > INGEST_LIMITS.maxEventPayloadBytes) {
    return {
      ok: false,
      code: 'event_too_large',
      reason: `event is ${bytes} bytes, over the ${INGEST_LIMITS.maxEventPayloadBytes}-byte per-event limit`,
    };
  }

  return { ok: true };
}
