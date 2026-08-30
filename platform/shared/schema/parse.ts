import { IdSchema } from './primitives';
import { TelemetryEventEnvelopeSchema, type TelemetryEventEnvelope } from './envelope';
import { eventTypeAvailableAt, type TelemetryEventType } from './event-type';
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
  // Step 3b: the type must exist at the declared schemaVersion. ADR 0005 decision 3 —
  // "New types arrive with a `schemaVersion` bump" — is only a rule if something enforces
  // it; without this check '1' and '2' would accept the identical nine types and the bump
  // would be a comment. Classified as UNKNOWN_EVENT_TYPE rather than
  // UNSUPPORTED_SCHEMA_VERSION because the version IS supported: it is the type that does
  // not exist in that version's vocabulary, which is §12's "unknown type" bullet.
  if (!eventTypeAvailableAt(envelope.type, envelope.schemaVersion)) {
    return reject(
      eventId,
      INGEST_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `event type ${JSON.stringify(envelope.type)} requires a later schemaVersion than ` +
        `${JSON.stringify(envelope.schemaVersion)}`,
    );
  }

  return BUILD_EVENT[envelope.type](envelope, eventId);
}

/**
 * One builder per type, rather than one `switch` with nine near-identical arms.
 *
 * The switch was the Phase 2 shape and it does not survive nine members: it broke
 * DESIGN-3 (cyclomatic complexity <= 15) at 22. Each builder is generic over its own
 * literal `K`, which is what keeps the property the switch was there for — the event is
 * constructed by naming every envelope field explicitly, never a blanket spread, so a
 * field added to TelemetryEventEnvelopeSchema is a compile error here rather than a
 * silently-dropped one. `satisfies Readonly<Record<TelemetryEventType, ...>>` is the
 * exhaustiveness check the switch used to give: a new member of TELEMETRY_EVENT_TYPES
 * with no builder does not compile.
 */
function buildEvent<K extends TelemetryEventType>(type: K) {
  return (envelope: TelemetryEventEnvelope, eventId: string): TelemetryEventParseResult => {
    const payloadResult = TELEMETRY_PAYLOAD_SCHEMAS[type].safeParse(envelope.payload);
    if (!payloadResult.success) {
      return reject(eventId, INGEST_ERROR_CODES.INVALID_PAYLOAD, 'payload failed validation');
    }
    // The `satisfies` clause is what carries the guarantee, and it is not decoration:
    // `Omit<TelemetryEventEnvelope, 'type' | 'payload'>` requires every remaining envelope
    // field by name, so a field added to TelemetryEventEnvelopeSchema and forgotten here is
    // a compile error — the property the Phase 2 switch was written for, kept in one place
    // instead of nine.
    //
    // The assertion narrows only `payload`. TypeScript cannot verify a mapped-type member
    // for a still-generic `K`, so it widens `payloadResult.data` to the union of all nine
    // payloads. What makes the narrowing true is that the schema was looked up by the very
    // same `type` (`TELEMETRY_PAYLOAD_SCHEMAS[type]`), and the registry is keyed
    // `satisfies Record<TelemetryEventType, z.ZodType>` — type and payload cannot disagree.
    const event = {
      eventId: envelope.eventId,
      schemaVersion: envelope.schemaVersion,
      type,
      entityId: envelope.entityId,
      runId: envelope.runId,
      occurredAt: envelope.occurredAt,
      payload: payloadResult.data,
    } satisfies Omit<TelemetryEventEnvelope, 'type' | 'payload'> & { type: K; payload: unknown };
    return { ok: true, event: event as TelemetryEventOf<K> };
  };
}

const BUILD_EVENT = {
  'run.started': buildEvent('run.started'),
  'run.completed': buildEvent('run.completed'),
  'step.started': buildEvent('step.started'),
  'step.completed': buildEvent('step.completed'),
  'decision.recorded': buildEvent('decision.recorded'),
  'decision.outcome_attested': buildEvent('decision.outcome_attested'),
  'model_call.recorded': buildEvent('model_call.recorded'),
  'tool_call.recorded': buildEvent('tool_call.recorded'),
  'error.recorded': buildEvent('error.recorded'),
} satisfies Readonly<
  Record<
    TelemetryEventType,
    (envelope: TelemetryEventEnvelope, eventId: string) => TelemetryEventParseResult
  >
>;
