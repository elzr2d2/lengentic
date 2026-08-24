/**
 * Public surface of the Playground's determinism seam. `MockProvider`, `MockAgent` and the
 * CLI (Phase 3 work packages 2, 3 and 6) import from here rather than reaching into
 * `seed.ts`/`telemetry.ts` directly, so this directory has one entry the same way the SDK
 * and the Playground composition root each have exactly one (`CLAUDE.md` `## Architecture`).
 */
export { createSeededComponents, SeededComponentsConfigError } from './seed';
export type { SeededClockOptions, SeededComponents } from './seed';

export { createSeededPlaygroundTelemetry } from './telemetry';
