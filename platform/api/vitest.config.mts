import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Integration tests bring up a Postgres container and are slower than the default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  // NestJS dependency injection needs `emitDecoratorMetadata`, which esbuild — Vitest's
  // default transformer — does not emit. SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
