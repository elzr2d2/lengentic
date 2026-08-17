/**
 * Gate thresholds (MVP_PLAN_V3.md §19).
 *
 * Every threshold is configurable and every gate is independent — that is a hard
 * requirement, not a convenience. Graduates from `spike/config.ts` verbatim plus
 * `Object.freeze`: wave 3 clones this per threshold-shift case, and a shared mutable
 * default poisons across test files in ways that look like flakiness.
 */
export interface AnalyzerConfig {
  /** G1 — minimum observations before any claim is made. */
  readonly minSampleCount: number;
  /** G2 — minimum distinct contextKeys the observations must span. */
  readonly minDistinctContexts: number;
  /** G3 — minimum share held by the dominant option, 0..1. */
  readonly dominanceThreshold: number;
  /** G4 — minimum attested success rate among attested decisions, 0..1. */
  readonly successThreshold: number;
  /** G5 — minimum fraction of decisions carrying a non-UNKNOWN outcome, 0..1. */
  readonly coverageThreshold: number;
}

export const DEFAULT_CONFIG: AnalyzerConfig = Object.freeze({
  minSampleCount: 30,
  minDistinctContexts: 5,
  dominanceThreshold: 0.9,
  successThreshold: 0.9,
  coverageThreshold: 0.8,
});
