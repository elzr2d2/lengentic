import { z } from 'zod';

import { type TelemetrySchemaVersion, schemaVersionAtLeast } from './schema-version';

// Naming is `<entity>.<verb-past>`, lowercase, dot-separated — settled in Phase 2 and not
// reopened here (.artifacts/plans/2-wave1-architect-brief.md §4). The dot is the entity
// namespace, which is why Phase 4 adds strings rather than a convention: `model_call.recorded`
// says the entity is `model_call`, where `model_call_recorded` could not.
//
// `decision.outcome_attested` rather than the brief's provisional `decision.attested`: §14
// names three columns the event writes (`outcome`, `outcomeAttestedBy`, `outcomeObservedAt`)
// and "attested" alone does not say what was attested. The packet deliverable fixes this
// spelling.
export const TELEMETRY_EVENT_TYPES = Object.freeze([
  'run.started',
  'run.completed',
  'step.started',
  'step.completed',
  'decision.recorded',
  'decision.outcome_attested',
  'model_call.recorded',
  'tool_call.recorded',
  'error.recorded',
] as const);

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export const TelemetryEventTypeSchema = z.enum(TELEMETRY_EVENT_TYPES);

/**
 * The schemaVersion each type first became legal at — ADR 0005 decision 3's bump, made
 * load-bearing rather than decorative.
 *
 * Without this map the bump would constrain nothing: `'1'` and `'2'` would accept exactly
 * the same nine types and "new types arrive with a schemaVersion bump" would be a comment
 * rather than a rule. A v1 emitter that sends `decision.recorded` is claiming a contract it
 * was not built against, and §12's event-level `unknown type` rejection is the right answer
 * — from a v1 reader's vocabulary that type does not exist.
 *
 * `satisfies Record<TelemetryEventType, ...>` is the same mechanism `registry.ts` uses:
 * adding a member to TELEMETRY_EVENT_TYPES without declaring its version is a compile error.
 */
export const TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION = Object.freeze({
  'run.started': '1',
  'run.completed': '1',
  'step.started': '1',
  'step.completed': '1',
  'decision.recorded': '2',
  'decision.outcome_attested': '2',
  'model_call.recorded': '2',
  'tool_call.recorded': '2',
  'error.recorded': '2',
} as const) satisfies Readonly<Record<TelemetryEventType, TelemetrySchemaVersion>>;

/** Whether `type` is legal to send at `version`. */
export function eventTypeAvailableAt(
  type: TelemetryEventType,
  version: TelemetrySchemaVersion,
): boolean {
  return schemaVersionAtLeast(version, TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION[type]);
}
