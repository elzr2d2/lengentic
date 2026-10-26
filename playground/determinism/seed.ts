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
import { hashToSeed } from '../providers';

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

/**
 * Folds a scenario's name into the seed its telemetry ids and clock are built from, so two
 * scenarios run with the same `--seed` never mint the same `(runId, eventId)` ledger key.
 *
 * The server dedups on that key. Before this existed, `repeated-failure` and
 * `deterministic-decision` both fed the raw seed to `SeededIdGenerator`, so at the shared
 * default seed 42 they emitted the same runId and five shared eventIds (Phase 6 wave-gate
 * F1) and posting both to one API silently merged or dropped data. `MockAgent` already does
 * this for its own scenario via `deriveScenarioSeed` (`agents/scenario-seed.ts`); this is the
 * same idiom for scenarios that do not go through `MockAgent`.
 *
 * `seed ^ hash(namespace)` is injective in `seed` for a fixed namespace, so "different seed
 * -> different ids" survives, and `| 0` keeps the result inside the 32-bit signed range
 * `validateSeed` enforces. Pure: the same `(namespace, seed)` always yields the same value,
 * which is what keeps "same seed -> identical output" (�17).
 *
 * Validates `seed` first, so an out-of-range `--seed` fails with the same
 * `SeededComponentsConfigError` it always did instead of being silently wrapped by `^`.
 */
export function namespacedSeed(namespace: string, seed: number): number {
  validateSeed(seed);
  return (seed ^ hashToSeed(`scenario:${namespace}`)) | 0;
}
