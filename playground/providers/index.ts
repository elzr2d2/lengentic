/**
 * `playground/providers`'s one export surface. `MockAgent` (a later, separate work
 * package) imports from here rather than reaching into `mock-provider.ts`/`prng.ts`
 * directly, matching the one-entry-point idiom `playground/index.ts` sets for the whole
 * Playground.
 */
export { MockProvider, MockProviderConfigError, MockProviderFailure } from './mock-provider';
export type {
  MockProviderConfig,
  MockProviderContextVariation,
  MockProviderRequest,
  MockProviderResponse,
} from './mock-provider';
