/**
 * `playground/providers`'s one export surface. `MockAgent` (a later, separate work
 * package) imports from here rather than reaching into `mock-provider.ts`/`prng.ts`
 * directly, matching the one-entry-point idiom `playground/index.ts` sets for the whole
 * Playground.
 *
 * `hashToSeed` is exported alongside the provider surface for one further consumer:
 * `playground/agents/scenario-seed.ts` derives a scenario's telemetry seed from the same
 * FNV-1a fold `MockProvider` already uses for its own per-call streams
 * (`prng.ts`'s own doc) — reusing it rather than writing a second hash implementation
 * (`playground/index.ts:11-13`'s "no second opinion" warning).
 */
export { MockProvider, MockProviderConfigError, MockProviderFailure } from './mock-provider';
export type {
  MockProviderConfig,
  MockProviderContextVariation,
  MockProviderRequest,
  MockProviderResponse,
} from './mock-provider';
export { hashToSeed } from './prng';
