/**
 * Gate thresholds (MVP_PLAN §71).
 *
 * Every threshold is configurable and every gate is independent — that is a hard
 * requirement (§74, §85), not a convenience. The whole point of Phase 0 is that these
 * numbers are cheap to argue about *now*.
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

export const DEFAULT_CONFIG: AnalyzerConfig = {
  minSampleCount: 30,
  minDistinctContexts: 5,
  dominanceThreshold: 0.9,
  successThreshold: 0.9,
  coverageThreshold: 0.8,
};
