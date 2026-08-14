import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. Fast, no Docker, safe to run on every save.
 *
 * Integration tests live in `test/` under vitest.integration.config.mts because they need
 * a Docker daemon. Mixing them here would mean `pnpm test` — and therefore `pnpm gates` —
 * fails on any machine without Docker, for reasons unrelated to the code.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  // NestJS dependency injection needs `emitDecoratorMetadata`, which esbuild — Vitest's
  // default transformer — does not emit. SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
