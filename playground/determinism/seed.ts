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
import { SeededClock, SeededIdGenerator, type Clock, type IdGenerator } from '../index';

export interface SeededComponents {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface SeededClockOptions {
  /** Milliseconds the clock advances on each `now()` call. SDK default: 1000. */
  readonly stepMs?: number;
}

/**
 * A `seed` this package's own boundary rejects before it ever reaches the SDK. Playground
 * side of R4: `SeededClock`/`SeededIdGenerator` build on `mulberry32`
 * (`platform/telemetry-sdk/src/prng.ts`), whose `let state = seed | 0` is a lossless,
 * collision-free `ToInt32` only inside the 32-bit signed integer range — outside it, two
 * seeds a caller reasonably believes are distinct (`-1` and `Number.MAX_SAFE_INTEGER`; `1`
 * and `1 + 2**32`) wrap to the same internal state and produce byte-identical output.
 * `platform/telemetry-sdk` is a Phase 2 surface and out of scope for this fix, so the range
 * is enforced here instead, at the one place the Playground turns a scenario seed into SDK
 * components.
 */
export class SeededComponentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeededComponentsConfigError';
  }
}

const MIN_SEED = -(2 ** 31);
const MAX_SEED = 2 ** 31 - 1;

function validateSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < MIN_SEED || seed > MAX_SEED) {
    throw new SeededComponentsConfigError(
      `createSeededComponents: seed must be a 32-bit signed integer (${MIN_SEED}..${MAX_SEED}), got ${seed}`,
    );
  }
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
  validateSeed(seed);
  return {
    clock: new SeededClock(seed, options),
    idGenerator: new SeededIdGenerator(seed),
  };
}
