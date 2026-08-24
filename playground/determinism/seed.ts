/**
 * Playground's determinism seam (`MVP_PLAN_V3.md` §17, Phase 3 work package 4).
 *
 * `platform/telemetry-sdk` already owns the `Clock`/`IdGenerator` interfaces and their
 * seeded implementations (`p2.sdk-injection`) and exports both through its public entry —
 * this module does not reimplement them; re-deriving "same seed → same sequence" a second
 * way is exactly the second opinion CLAUDE.md's `## Architecture` warns a consumer package
 * against forming. Its only job is to be the one place the Playground turns a scenario
 * `seed` into the matched pair a telemetry client needs, so MockProvider, MockAgent and the
 * CLI share one construction site instead of each minting its own
 * `SeededClock`/`SeededIdGenerator`.
 */
import {
  SeededClock,
  SeededIdGenerator,
  type Clock,
  type IdGenerator,
} from '@lengentic/telemetry-sdk';

export interface SeededComponents {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface SeededClockOptions {
  /** Milliseconds the clock advances on each `now()` call. SDK default: 1000. */
  readonly stepMs?: number;
}

/**
 * One seed → one deterministic `Clock` and one deterministic `IdGenerator`, freshly
 * constructed on every call. Two calls with the same seed produce components whose
 * `.now()`/`.next()` sequences are identical when driven the same number of times — that
 * guarantee is the SDK's (`platform/telemetry-sdk/src/{clock,ids}.ts`) and is exercised end
 * to end, through a real `TelemetryClient`, by `test/telemetry.spec.ts` in this directory.
 *
 * Deliberately not memoized per seed: a memoized instance shared across two callers would
 * let one scenario's calls silently advance another's clock/id sequence, which is the
 * opposite of what §17 needs from a mock scenario run more than once.
 */
export function createSeededComponents(
  seed: number,
  options?: SeededClockOptions,
): SeededComponents {
  return {
    clock: new SeededClock(seed, options),
    idGenerator: new SeededIdGenerator(seed),
  };
}
