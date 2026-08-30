/**
 * Derives `MockAgent`'s telemetry seed from the whole scenario, not from `config.seed`
 * alone — the fix for F1 (`.artifacts/evidence/3/phase-gate/tester/README.md`, and the
 * architect decision at `.artifacts/evidence/3/phase-gate/repair-1/architect-f1-decision.md`
 * §A). Before this module existed, two scenarios sharing a `seed` but differing in
 * `workflowName`, `contextSeed`, or any other config field minted the *same* runId — the
 * `(runId, eventId)` ledger key (`platform/database/prisma/schema.prisma:182-197`) then
 * silently deduplicated the second scenario's telemetry as a re-send of the first.
 *
 * ```
 * telemetrySeed = (config.seed ^ hashToSeed(canonical(config minus {seed, scheduler, telemetryConfig}))) | 0
 * ```
 *
 * Five properties this derivation must hold, each load-bearing:
 *
 * 1. **Denylist, never allowlist.** `withoutSeedIdentity` removes exactly `seed`,
 *    `scheduler` and `telemetryConfig` and hashes *everything else* `MockAgentConfig`
 *    carries. An allowlist fails open — a future config field would silently reintroduce
 *    the exact collision this module exists to close. `scheduler` and `telemetryConfig`
 *    are excluded because both change *timing and batching*, never a per-event byte: two
 *    runs differing only in those emit identical wire bytes, so treating them as the same
 *    scenario is correct, not a gap.
 * 2. **XOR with `seed`, never folded into the hash.** `seed ^ hashToSeed(rest)` is
 *    injective in `seed` for a fixed `rest` — same idiom `MockProvider` already uses
 *    (`playground/providers/mock-provider.ts:260`) — which is what keeps "different seed →
 *    different telemetry" (the negative control every determinism test in this package
 *    relies on) true after this change, not just before it.
 * 3. **`| 0`, never `>>> 0`.** `hashToSeed` returns an unsigned 32-bit value
 *    (`playground/providers/prng.ts:36`). JS `^` already produces a signed int32, which is
 *    inside `playground/determinism/seed.ts`'s `MIN_SEED..MAX_SEED`; `>>> 0` would push the
 *    result back out of that range and trip `SeededComponentsConfigError` for roughly half
 *    of all inputs.
 * 4. **`canonical` is total and fails loudly.** Recursive, object keys sorted
 *    lexicographically, arrays kept in order, `undefined`-valued keys omitted (so an absent
 *    optional field and one explicitly set to `undefined` derive the same seed). A circular
 *    reference throws `ScenarioSeedError` rather than silently falling back to the raw seed
 *    — a silent fallback would reinstate exactly the collision this module closes.
 * 5. **Pure.** No `Date`, no `Math.random`, no `process.env`, no module-level mutable
 *    state — the same scenario must derive the same seed in any process, at any time, under
 *    any locale.
 */
import { hashToSeed } from '../providers';
import type { MockAgentConfig } from './types';

export class ScenarioSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioSeedError';
  }
}

/** `MockAgentConfig` minus the three fields that must never influence which telemetry
 *  scenario a run is treated as (see the module doc's point 1). */
function withoutSeedIdentity(
  config: MockAgentConfig,
): Omit<MockAgentConfig, 'seed' | 'scheduler' | 'telemetryConfig'> {
  const { seed: _seed, scheduler: _scheduler, telemetryConfig: _telemetryConfig, ...rest } = config;
  return rest;
}

/** Recursive, key-sorted, `undefined`-omitting serialization — deliberately not
 *  `JSON.stringify`, which is key-insertion-order-dependent and does not distinguish "throws
 *  on a cycle" from "throws on a `BigInt`" the way this module needs to (point 4). `path`
 *  tracks the objects currently being serialized on the current recursive path, so the same
 *  object reachable twice through two different paths is not mistaken for a cycle. */
function canonical(value: unknown, path: ReadonlySet<object> = new Set()): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (type === 'string') return JSON.stringify(value);
  if (type === 'undefined') return 'null';

  if (type !== 'object') {
    // `function`, `symbol`, `bigint` — none of `MockAgentConfig`'s denylist-surviving
    // fields (contextSeed, delayMs, failureRate, alwaysFailSteps, tasks,
    // availableConcurrency, maxConcurrency, awarenessContext, workflowName,
    // workflowVersion, metadata, clockOptions) are meant to carry one; a caller that puts
    // one there gets a loud, named failure instead of a derivation that silently ignored it.
    throw new ScenarioSeedError(`deriveScenarioSeed: cannot serialize a value of type "${type}"`);
  }

  const object = value as object;
  if (path.has(object)) {
    throw new ScenarioSeedError('deriveScenarioSeed: config contains a circular reference');
  }
  const nextPath = new Set(path);
  nextPath.add(object);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry, nextPath)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key], nextPath)}`);
  return `{${entries.join(',')}}`;
}

/**
 * One `MockAgentConfig` → one telemetry seed. Two calls with configs that are equal after
 * `withoutSeedIdentity`/`canonical` (same `seed`, same everything else except `scheduler`
 * and `telemetryConfig`) always derive the same seed; two calls that differ in any other
 * field derive different seeds with overwhelming probability (FNV-1a over the canonical
 * string, XORed against `seed`).
 *
 * Deliberately does not validate `config.seed`'s range: `^` and `| 0` both coerce through
 * `ToInt32`, so the derived value is always a valid 32-bit signed integer regardless of
 * whether `config.seed` itself was one. Range validation for `seed` stays exactly where it
 * already lived — `MockProvider`'s constructor (`playground/providers/mock-provider.ts:118`)
 * — so `MockAgent` must call this only after that validation has had the chance to run
 * first (see `mock-agent.ts`'s constructor), keeping the out-of-range error message the one
 * callers already depend on (AC-9).
 */
export function deriveScenarioSeed(config: MockAgentConfig): number {
  const rest = withoutSeedIdentity(config);
  return (config.seed ^ hashToSeed(canonical(rest))) | 0;
}
