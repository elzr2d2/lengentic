import { fileURLToPath } from 'node:url';
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
 *
 * It is still `node` now that the pages themselves are under test. The App Router pages are
 * async Server Components: React calls them, awaits the element tree they return, and renders
 * that tree — which `react-dom/server`'s `renderToStaticMarkup` does here without a document,
 * a window, or a testing-library. jsdom would buy nothing this suite asserts on (there are no
 * events, no effects and no client components on these pages) and would make every pure
 * function in `src/lib` pay for a DOM.
 */
export default defineConfig({
  resolve: {
    // The same `@/*` -> `./src/*` mapping `tsconfig.json` gives the Next build. Without it a
    // test that imports a page cannot resolve the page's own imports.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  oxc: {
    // `tsconfig.json` says `jsx: "preserve"` because Next owns that transform. Vitest has no
    // Next in front of it, so it needs the runtime transform named here instead. On Vite's
    // oxc transformer, not esbuild — Vite 8 prefers oxc and ignores the esbuild block.
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'test/**/*.spec.ts'],
  },
});
