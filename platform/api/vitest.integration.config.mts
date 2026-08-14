import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests. Require a running Docker daemon — Testcontainers starts a real
 * PostgreSQL per suite.
 *
 * Not wired into `pnpm test` or `pnpm gates`. CI runs this separately, where Docker is
 * guaranteed to exist, so a missing daemon reads as "integration tests did not run"
 * instead of "the build is broken".
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.spec.ts'],

    // Pulling and starting a Postgres image on a cold cache is slow, and a timeout here
    // looks exactly like a failing assertion.
    testTimeout: 60_000,
    hookTimeout: 180_000,

    // Each suite owns a container. Running them concurrently would exhaust local Docker
    // and produce failures that have nothing to do with the code.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
