import type { Provider } from '@nestjs/common';
import { DEFAULT_CONFIG } from '@lengentic/analysis-engine';

/**
 * §19's five thresholds, as an injected value rather than an ambient import.
 *
 * §19 requires every threshold to be configurable, and the engine already satisfies that by
 * taking `AnalyzerConfig` as a parameter to `evaluateGates` — no gate function anywhere in
 * `platform/analysis-engine` reads a module-level constant. This provider is the API's end of
 * that: the thresholds in force come from the server (§22), and injecting them means a test can
 * construct `AnalysisService` with a shifted threshold and observe a verdict flip without
 * touching an environment variable or the engine's own default.
 *
 * `DEFAULT_CONFIG` is the shipped value. No environment variable is read: §22 gives analysis no
 * request parameters and no per-call configuration, and adding five env vars nothing sets would
 * be speculative surface (`docs/ENGINEERING_STANDARDS.md` DESIGN-1 — an abstraction needs a
 * second REAL variation). `BACKLOG.md` is where a real need for per-deployment thresholds goes.
 *
 * The value is what `toWireConfigSnapshot` records on every recommendation as §21's
 * `configSnapshot`, so a change here is visible on each row it produced rather than invisible.
 */
export const ANALYZER_CONFIG = Symbol('AnalyzerConfig');

export const analyzerConfigProvider: Provider = {
  provide: ANALYZER_CONFIG,
  useValue: DEFAULT_CONFIG,
};
