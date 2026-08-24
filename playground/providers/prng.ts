/**
 * mulberry32: a small, fast, dependency-free deterministic PRNG. `MockProvider` needs
 * exactly one property from it — the same numeric seed always produces the same sequence
 * of `[0, 1)` draws — never anything security-sensitive.
 *
 * `platform/telemetry-sdk/src/prng.ts` already implements this exact generator behind
 * `SeededClock` and `SeededIdGenerator`, but it is not part of the SDK's public entry
 * (`playground-sdk-public-entry-only`, `pnpm check:boundaries` forbids a deep import into
 * `@lengentic/telemetry-sdk/src/**`), so the Playground keeps its own copy of a
 * public-domain algorithm instead of reaching past the SDK's seam.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, 32-bit. Folds a call's identity — `step`, `callIndex`, and a per-purpose salt —
 * into one number, so a single `MockProvider` `seed` can hand each of its internal random
 * streams (failure roll, delay jitter, context variation) an independent, still-reproducible
 * seed of its own. The result is a pure function of the call's identity, not of how many
 * times `invoke()` happened to have run before it — which is what keeps a scenario's output
 * stable if a caller retries a step, calls two steps out of order, or skips one entirely.
 */
export function hashToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
