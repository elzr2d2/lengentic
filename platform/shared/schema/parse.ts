import { IdSchema } from './primitives';
import { TelemetryEventEnvelopeSchema } from './envelope';
import { TELEMETRY_PAYLOAD_SCHEMAS, type TelemetryEvent, type TelemetryEventOf } from './registry';
import { INGEST_ERROR_CODES, type IngestErrorCode } from './ingest';

export type TelemetryEventParseResult =
  | { readonly ok: true; readonly event: TelemetryEvent }
  | {
      readonly ok: false;
      /**
       * '' when the event carried no readable eventId — the IngestResult.eventId
       * sentinel. IngestResultSchema.eventId is z.string() (ingest.ts), so the sentinel
       * must itself be a string; it was never legal for it to be null. See
       * .artifacts/evidence/2/wire-contract-recovery.md S6.
       */
      readonly eventId: string;
      readonly code: IngestErrorCode;
      readonly message: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEventId(input: Record<string, unknown>): string {
  const parsed = IdSchema.safeParse(input['eventId']);
  return parsed.success ? parsed.data : '';
}

function reject(
  eventId: string,
  code: IngestErrorCode,
  message: string,
): TelemetryEventParseResult {
  return { ok: false, eventId, code, message };
}

const REQUIRED_FIELD_KEYS = new Set(['eventId', 'entityId', 'runId', 'occurredAt']);

/**
 * Classifies a TelemetryEventEnvelopeSchema failure into the §12 bullet order:
 * schemaVersion, then type, then the remaining required fields. This is the only place
 * envelope validity is *decided* — parseTelemetryEvent never re-implements a field check
 * TelemetryEventEnvelopeSchema already owns. See
 * .artifacts/evidence/2/wire-contract-recovery.md S1.
 */
function classifyEnvelopeFailure(
  input: Record<string, unknown>,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): { code: IngestErrorCode; message: string } {
  if (issues.some((issue) => issue.path[0] === 'schemaVersion')) {
    return {
      code: INGEST_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      message: `unsupported schemaVersion: ${JSON.stringify(input['schemaVersion'])}`,
    };
  }
  if (issues.some((issue) => issue.path[0] === 'type')) {
    return {
      code: INGEST_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      message: `unknown event type: ${JSON.stringify(input['type'])}`,
    };
  }
  const requiredFieldIssue = issues.find(
    (issue) => typeof issue.path[0] === 'string' && REQUIRED_FIELD_KEYS.has(issue.path[0]),
  );
  if (requiredFieldIssue) {
    return {
      code: INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD,
      message: `missing or invalid required field: ${String(requiredFieldIssue.path[0])}`,
    };
  }
  // Only `payload` remains among TelemetryEventEnvelopeSchema's keys — verified against
  // zod 4.4.3: z.unknown() accepts an explicit `payload: undefined` (safeParse succeeds)
  // but rejects an absent `payload` key (fails with expected: "nonoptional"), so a
  // wholly-missing payload surfaces here rather than in the per-type payload check below
  // (§12 bullet 4, "payload fails its Zod schema").
  return {
    code: INGEST_ERROR_CODES.INVALID_PAYLOAD,
    message: 'payload failed validation',
  };
}

/**
 * The §12 rejection classifier — the one entry point that answers "is this event valid".
 * Envelope validity is decided by TelemetryEventEnvelopeSchema itself, not a hand-rolled
 * equivalent (see .artifacts/evidence/2/wire-contract-recovery.md S1). Check order is
 * §12's bullet order, verbatim: an event wrong in two ways reports the earlier bullet.
 * This is the only non-arbitrary order available.
 */
export function parseTelemetryEvent(input: unknown): TelemetryEventParseResult {
  // Step 0: not a plain object folds into MISSING_REQUIRED_FIELD — it is literally
  // missing all four required fields. No separate MALFORMED_EVENT code; §12 never
  // authorises one and the remedy is identical.
  if (!isPlainObject(input)) {
    return reject('', INGEST_ERROR_CODES.MISSING_REQUIRED_FIELD, 'event must be a JSON object');
  }

  const eventId = readEventId(input);

  // Steps 1-3: schemaVersion, type, and the remaining required identity/time fields —
  // all decided by the declared envelope schema. Adding a required field to
  // TelemetryEventEnvelopeSchema changes what `envelope` below carries; every switch
  // case constructs its event by naming fields explicitly (never a blanket spread), so
  // a field the schema now requires but a case omits is a compile error here, not a
  // silently-passed `as` cast. See .artifacts/evidence/2/wire-contract-recovery.md S1.
  const envelopeResult = TelemetryEventEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    const { code, message } = classifyEnvelopeFailure(input, envelopeResult.error.issues);
    return reject(eventId, code, message);
  }
  const envelope = envelopeResult.data;

  // Step 4: payload against its registered schema, per event type. Cross-field rules
  // over entityId/runId/parentStepId that used to live here were dropped — neither §12
  // nor §13 authorises them (see .artifacts/evidence/2/wire-contract-recovery.md S4).
  switch (envelope.type) {
    case 'run.started': {
      const payloadResult = TELEMETRY_PAYLOAD_SCHEMAS[envelope.type].safeParse(envelope.payload);
      if (!payloadResult.success) {
        return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
      }
      const event: TelemetryEventOf<'run.started'> = {
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        type: 'run.started',
        entityId: envelope.entityId,
        runId: envelope.runId,
        occurredAt: envelope.occurredAt,
        payload: payloadResult.data,
      };
      return { ok: true, event };
    }
    case 'run.completed': {
      const payloadResult = TELEMETRY_PAYLOAD_SCHEMAS[envelope.type].safeParse(envelope.payload);
      if (!payloadResult.success) {
        return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
      }
      const event: TelemetryEventOf<'run.completed'> = {
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        type: 'run.completed',
        entityId: envelope.entityId,
        runId: envelope.runId,
        occurredAt: envelope.occurredAt,
        payload: payloadResult.data,
      };
      return { ok: true, event };
    }
    case 'step.started': {
      const payloadResult = TELEMETRY_PAYLOAD_SCHEMAS[envelope.type].safeParse(envelope.payload);
      if (!payloadResult.success) {
        return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
      }
      const event: TelemetryEventOf<'step.started'> = {
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        type: 'step.started',
        entityId: envelope.entityId,
        runId: envelope.runId,
        occurredAt: envelope.occurredAt,
        payload: payloadResult.data,
      };
      return { ok: true, event };
    }
    case 'step.completed': {
      const payloadResult = TELEMETRY_PAYLOAD_SCHEMAS[envelope.type].safeParse(envelope.payload);
      if (!payloadResult.success) {
        return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
      }
      const event: TelemetryEventOf<'step.completed'> = {
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        type: 'step.completed',
        entityId: envelope.entityId,
        runId: envelope.runId,
        occurredAt: envelope.occurredAt,
        payload: payloadResult.data,
      };
      return { ok: true, event };
    }
  }
}
