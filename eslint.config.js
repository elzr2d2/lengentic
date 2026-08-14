import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Deliberately narrow. Architectural rules (who may import whom) are NOT enforced here —
 * they belong to `pnpm check:boundaries` (dependency-cruiser), per MVP_PLAN.md §17.
 * Two tools owning the same rule is how the two drift apart and one of them starts lying.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
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
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message:
            'Use a union of string literals. Enums do not survive the Zod/Prisma boundary cleanly.',
        },
      ],
    },
  },

  {
    // The spike is a CLI. Writing to stdout is its entire job.
    files: ['spike/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // Plain-JS Node scripts: hooks and config. typescript-eslint turns `no-undef` off for
    // .ts files because the compiler already does it better, but these are not compiled,
    // so the globals have to be declared.
    files: ['.claude/hooks/**/*.mjs', '*.config.js', '*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
  },

  prettier,
);
