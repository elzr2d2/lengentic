import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Deliberately narrow. Architectural rules (who may import whom) are NOT enforced here —
 * they belong to `pnpm check:boundaries` (dependency-cruiser), per MVP_PLAN.md §17.
 * Two tools owning the same rule is how the two drift apart and one of them starts lying.
 *
 * Rule IDs below map to `docs/ENGINEERING_STANDARDS.md`, which is the standards SSOT and
 * names this file as the enforcer. A rule that is enforced here is not restated in an
 * agent prompt.
 */

/**
 * `no-restricted-syntax` is one rule with one array, and a later block that re-declares it
 * replaces the array wholesale rather than extending it. Both selectors are therefore
 * named here and composed per block, so the test-file exemption drops exactly one of them.
 */
const NO_ENUMS = {
  selector: 'TSEnumDeclaration',
  message: 'Use a union of string literals. Enums do not survive the Zod/Prisma boundary cleanly.',
};

const NO_DOUBLE_ASSERTION = {
  selector: 'TSAsExpression > TSAsExpression',
  message:
    'TS-3: `x as unknown as T` silences the compiler instead of proving the invariant. Parse ' +
    'the value, narrow it, or widen the declared type. Test doubles are exempt — see the ' +
    'test-file block below.',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      // `.artifacts/` is gitignored evidence: captured logs, and the throwaway probe
      // scripts an agent wrote to produce them. It is a record of what happened, not
      // source, and it is written DURING a run — a session that dropped a probe there
      // was breaking `pnpm lint` for every other session, on files nobody may edit to
      // fix. Observed 2026-08-20, in the standards pass.
      '.artifacts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': ['error', NO_ENUMS, NO_DOUBLE_ASSERTION],
    },
  },

  {
    /**
     * Type-aware linting (ENGINEERING_STANDARDS §TS and §ASYNC).
     *
     * Adopted rule by rule, not as `recommended-type-checked` wholesale — the preset also
     * carries rules that would churn this repository without catching a defect, and the
     * standards document has to be able to say what each enabled rule proves.
     *
     * Every rule below was measured against the tree before it was enabled. Eight of them
     * had zero violations and are pure ratchets; the rest had 13 between them, all fixed in
     * the commit that turned them on. Cost: `pnpm lint` 2.5s -> ~11.5s full-tree. The
     * pre-commit ladder lints staged files only, so the inner loop does not pay it.
     *
     * `allowDefaultProject` covers the three .ts files no tsconfig includes. They are
     * config/seed scripts at the edge of the build; adding them to a package tsconfig
     * would put them in that package's emit.
     */
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'platform/dashboard/next.config.ts',
            'platform/database/prisma.config.ts',
            'platform/database/prisma/seed.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ASYNC-1..3 — a promise nobody awaited is a failure nobody sees.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      // TS-2 — unknown data must be narrowed, not asserted through.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // TS-4 — an assertion that changes nothing is a claim the reader has to re-check.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // TS-5 — a union that grew a member must not silently fall through a switch.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // OBS-3 — "[object Object]" in a log line is evidence that was never captured.
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
    },
  },

  {
    /**
     * Test doubles are the one honest use of a double assertion: a partial stub standing in
     * for a class the test never calls the rest of. Production code has none today and the
     * rule above keeps it that way.
     */
    files: ['**/*.{spec,test}.ts', '**/test/**/*.ts', '**/fixtures/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_ENUMS] },
  },

  {
    /**
     * Bounded complexity, product code only (ENGINEERING_STANDARDS §DESIGN-3).
     *
     * 15 is not a book number. The most complex function in platform/ today is 14
     * (`assertAgainstGrid`), so 15 is the observed ceiling plus one: it fails nothing now
     * and blocks the next 30-branch function. `scripts/**` is exempt — the harness has
     * functions at 61, and refactoring them is its own work, filed in BACKLOG.md.
     */
    files: ['platform/**/*.{ts,tsx}', 'playground/**/*.{ts,tsx}'],
    rules: { complexity: ['error', 15] },
  },

  {
    /**
     * The one Prisma leak dependency-cruiser cannot see (ENGINEERING_STANDARDS §ARCH-4).
     *
     * `no-prisma-in-the-wire-contract` catches `@prisma/client`, but the cruiser excludes
     * `generated/` from its graph, so a DEEP import into the generated client
     * (`platform/database/src/generated/prisma/**`) is dropped before any rule sees it.
     * That path is lexical, and this rule is lexical, so the hole closes here instead of
     * being widened in the cruiser's exclude list — where it would slow every cruise and
     * pull thousands of generated modules into the graph.
     */
    files: [
      'platform/shared/**/*.ts',
      'platform/analysis-engine/**/*.ts',
      'platform/telemetry-sdk/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/generated/prisma', '**/generated/prisma/**', '@prisma/client'],
              message:
                'Prisma types are database-internal and never cross a module boundary ' +
                '(CLAUDE.md ## Types). Map explicitly at the persistence edge.',
            },
          ],
        },
      ],
    },
  },

  {
    // The spike is a CLI. Writing to stdout is its entire job. Package build scripts
    // (platform/*/scripts/*.mjs) are the same kind of thing.
    files: ['spike/**/*.ts', 'scripts/**/*.ts', 'platform/*/scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  {
    // NestJS resolves providers from `emitDecoratorMetadata`, which an `import type` on an
    // injected class erases. The rule and the framework are in direct conflict here, and
    // the framework wins because the failure is a runtime DI error rather than a lint one.
    files: ['platform/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },

  {
    files: ['platform/dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        React: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        process: 'readonly',
      },
    },
  },

  {
    // Plain-JS Node scripts: hooks and config. typescript-eslint turns `no-undef` off for
    // .ts files because the compiler already does it better, but these are not compiled,
    // so the globals have to be declared.
    files: ['.claude/hooks/**/*.mjs', 'platform/*/scripts/**/*.mjs', '*.config.js', '*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
  },

  prettier,
);
