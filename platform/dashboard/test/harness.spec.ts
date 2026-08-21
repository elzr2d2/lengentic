import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The address resolution in `src/lib/api.ts` is the one dashboard behaviour that has already
 * shipped broken: under `docker compose` the Server Component used the browser's address,
 * resolved it to its own loopback, and rendered "API unreachable" while both containers were
 * healthy. These tests pin the server-side branch against that.
 *
 * `API_BASE_URL` is read at module scope, so each case resets the module registry and
 * re-imports. Without that, the first import freezes the environment for the whole file.
 */
const loadApi = async () => import('../src/lib/api.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('resolveApiBaseUrl, server side', () => {
  it('prefers the internal address over the public one', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3001');
    vi.stubEnv('API_BASE_URL_INTERNAL', 'http://api:3001');
    vi.resetModules();

    const { resolveApiBaseUrl } = await loadApi();

    expect(resolveApiBaseUrl()).toBe('http://api:3001');
  });

  it('falls back to the public address when no internal one is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3001');
    vi.stubEnv('API_BASE_URL_INTERNAL', undefined);
    vi.resetModules();

    const { resolveApiBaseUrl } = await loadApi();

    expect(resolveApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('defaults to localhost:3001 when neither is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    vi.stubEnv('API_BASE_URL_INTERNAL', undefined);
    vi.resetModules();

    const { resolveApiBaseUrl } = await loadApi();

    expect(resolveApiBaseUrl()).toBe('http://localhost:3001');
  });
});
