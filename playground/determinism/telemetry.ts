/**
 * Wires §17 determinism into a real telemetry client, from the Playground side.
 *
 * `../index` (the Playground's composition root) is the one place `MVP_PLAN_V3.md` §4
 * allows the Playground to name the SDK; this module builds on it rather than calling
 * `createTelemetryClient` a second, competing way. "Wired into the SDK" means exactly this:
 * a seed goes in here, and a real `TelemetryClient` — built through the SDK's own public
 * injection point (`TelemetryConfig.clock` / `TelemetryConfig.idGenerator`) — comes out.
 */
import { createPlaygroundTelemetry } from '../index';
import type { TelemetryClient, TelemetryConfig } from '../index';
import { createSeededComponents, type SeededClockOptions } from './seed';

/**
 * Builds a Playground telemetry client whose id and timestamp sequence are a pure function
 * of `seed`. Everything else in `config` (endpoint, transport, batching, `onDiagnostic`, …)
 * composes normally, but a `clock` or `idGenerator` supplied in `config` is deliberately
 * overridden by the seeded pair: accepting a caller's own would let a scenario silently
 * defeat the one guarantee this function exists to make (`test/telemetry.spec.ts` proves the
 * override, not just the type, does the work).
 */
export function createSeededPlaygroundTelemetry(
  seed: number,
  config: TelemetryConfig = {},
  clockOptions?: SeededClockOptions,
): TelemetryClient {
  const { clock, idGenerator } = createSeededComponents(seed, clockOptions);
  return createPlaygroundTelemetry({ ...config, clock, idGenerator });
}
