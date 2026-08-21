import { defineConfig } from 'vitest/config';

/**
 * `include` covers two roots on purpose.
 *
 * `src/**` is where feature tests live, colocated with the code — that is the surface a
 * dashboard work packet owns, so a lane can add a test without widening its boundary.
 * `test/**` is for tests that belong to the package rather than to one module.
 *
 * `environment: 'node'` matches every other package here. A test that needs a DOM declares
 * it per file with `// @vitest-environment jsdom` rather than making every pure function
 * pay for a document.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'test/**/*.spec.ts'],
  },
});
