import { z } from 'zod';

// The wire's schemaVersion vocabulary, in its own module rather than in `envelope.ts`,
// because `event-type.ts` needs it too (to say which version a type first appeared in)
// and `envelope.ts` already imports `event-type.ts`. Putting it in either of those two
// files makes the cycle.
//
// `'1'` — Phase 2. Run and Step only (§12:474, ADR 0005 decision 3).
// `'2'` — Phase 4. Adds decision / model_call / tool_call / error (ADR 0005 decision 3,
//         "New types arrive with a `schemaVersion` bump").
export const TELEMETRY_SCHEMA_VERSIONS = Object.freeze(['1', '2'] as const);

export type TelemetrySchemaVersion = (typeof TELEMETRY_SCHEMA_VERSIONS)[number];

export const TelemetrySchemaVersionSchema = z.enum(TELEMETRY_SCHEMA_VERSIONS);

/**
 * The version an SDK emits today. Distinct from `TELEMETRY_SCHEMA_VERSIONS`, which is what
 * the API still *accepts*: `'1'` stays accepted deliberately. Widening what the contract
 * accepts is backward-compatible and reversible; narrowing it is not, and CLAUDE.md prefers
 * the reversible option under uncertainty — the same argument `run-events.ts` records for
 * `.nullish()` metadata. A hard cutover would also reject every already-emitted v1 event,
 * which §12 gives no reason to do: the bump exists to gate *new types*, not to retire old
 * events.
 */
export const TELEMETRY_SCHEMA_VERSION = '2' as const satisfies TelemetrySchemaVersion;

const VERSION_ORDER: Readonly<Record<TelemetrySchemaVersion, number>> = Object.freeze({
  '1': 1,
  '2': 2,
});

/** True when `actual` is at least `minimum` in the ordering above. */
export function schemaVersionAtLeast(
  actual: TelemetrySchemaVersion,
  minimum: TelemetrySchemaVersion,
): boolean {
  return VERSION_ORDER[actual] >= VERSION_ORDER[minimum];
}
