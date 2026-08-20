import {
  TELEMETRY_PAYLOAD_SCHEMAS,
  TelemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from '@lengentic/shared';

/**
 * The independent oracle (TEST-4). `@lengentic/shared` is a different package, owned by a
 * different packet, and it is the same code the API validates incoming events with — so an
 * envelope this accepts is one the API accepts, and neither side can agree with the SDK by
 * construction.
 *
 * Returns the reasons the event is NOT on the contract; an empty array means it is.
 */
export function wireContractViolations(event: TelemetryEventEnvelope): string[] {
  const envelope = TelemetryEventEnvelopeSchema.safeParse(event);
  if (!envelope.success) return [`envelope: ${envelope.error.message}`];

  const payload = TELEMETRY_PAYLOAD_SCHEMAS[envelope.data.type].safeParse(envelope.data.payload);
  return payload.success ? [] : [`payload(${envelope.data.type}): ${payload.error.message}`];
}
