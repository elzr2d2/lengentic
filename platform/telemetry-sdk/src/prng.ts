/**
 * mulberry32: a small, fast, dependency-free deterministic PRNG. The only thing §17's
 * `SeededClock` and `SeededIdGenerator` need from it is that the same numeric seed always
 * produces the same sequence of outputs — never used for anything security-sensitive.
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
