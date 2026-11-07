# Coding Conventions

**Analysis Date:** 2026-10-29

## Authority and scope

Use `docs/ENGINEERING_STANDARDS.md` as the standards source of truth. This map points to mechanisms and examples; it does not replace those rules. `MVP_PLAN_V3.md` owns product contracts, `CONTEXT.md` owns vocabulary, and `CLAUDE.md` records working constraints. Findings below come from static inspection, not a fresh passing gate run.

## Naming Patterns

- Use kebab-case TypeScript filenames: `platform/api/src/analysis/analysis-source.ts`.
- Nest features use `*.module.ts`, `*.controller.ts`, `*.service.ts`, and `*.repository.ts`; see `platform/api/src/analysis/`.
- Use PascalCase classes and schemas, camelCase functions and values, and uppercase constant tokens: `AnalysisService`, `AnalysisRunResponseSchema`, `toEngineDecisionRecords`, `CLOCK` in `platform/api/src/analysis/analysis.service.ts`.
- Use string literal unions instead of TypeScript enums; `eslint.config.js` enforces this.
- Use the words “attested success rate” and “counterexamples” consistently; epistemic constraints are in `CONTEXT.md` and `MVP_PLAN_V3.md` sections 2 and 19.

## Code Style

- Prettier: 100-column print width, single quotes, semicolons, trailing commas, LF; see `.prettierrc.json`.
- ESLint flat configuration: `eslint.config.js`; run `pnpm lint` and `pnpm format:check`.
- Strict compiler checks include unchecked indexed access, exact optional properties, explicit override, unknown catch values, and missing-return/fallthrough checks: `tsconfig.base.json`.
- Type-aware lint rejects floating/misused promises, unsafe assignments/calls/returns, unnecessary assertions, and non-exhaustive switches: `eslint.config.js`.
- Product functions have an ESLint complexity ceiling of 15. Harness scripts are outside that ceiling: `eslint.config.js`.

## Import Organization

1. Standard/library and workspace imports.
2. A blank line, then feature-local imports.

This is an observed organization in `platform/api/src/analysis/analysis.service.ts`; an automatic import-order rule was not established in this review. Use `type` imports as required by ESLint. Dashboard `@/*` resolves to `src/*` in `platform/dashboard/tsconfig.json` and `platform/dashboard/vitest.config.mts`.

Import workspace public entries. Never import playground from platform, API internals from SDK, or Prisma models through a public service response. `.dependency-cruiser.cjs` owns import boundaries; `pnpm check:boundaries` checks them.

## Error Handling

- Validate external data using shared Zod schemas, and map persistence records explicitly at the repository edge: `platform/api/src/analysis/analysis.repository.ts`.
- API failures use the global `AllExceptionsFilter`; 5xx responses hide internal details while server logs retain the exception: `platform/api/src/common/all-exceptions.filter.ts`.
- Install the one configured body parser before application initialization; the default Nest parser is disabled: `platform/api/src/main.ts`, `platform/api/src/common/configure-body-parser.ts`.
- SDK resilience belongs at its public client seam; see `platform/telemetry-sdk/test/resilience.spec.ts` and `shutdown.spec.ts`.

## Logging

API uses `nestjs-pino`, installed as the application logger in `platform/api/src/main.ts`. The exception filter logs structured error/path/method fields. `eslint.config.js` rejects general console output in its base rules, with explicit file-scope exceptions. Consult those exceptions before adopting console logging.

## Comments

Use comments to explain contract ownership and non-obvious failure modes. `platform/api/src/analysis/analysis.service.ts` explains why analysis is explicit and why one clock reading governs a run. `platform/api/src/main.ts` explains the body-parser ordering hazard. Prefer references to owning plan sections over copying the whole requirement.

## Function Design

- Inject time and IDs for reproducibility; `platform/telemetry-sdk/test/determinism.spec.ts` exercises `SeededClock` and `SeededIdGenerator` through the public client.
- Keep analysis pure and persistence in the API: `platform/analysis-engine/package.json`, `platform/api/src/analysis/analysis.service.ts`.
- Return explicit domain/wire shapes, never ORM rows: `platform/api/src/analysis/analysis.repository.ts`.
- Use readonly input/output members where applicable; see `AnalysisDecisionSource` in `platform/api/src/analysis/analysis-source.ts`.

## Module Design

Use a small public entry (`src/index.ts`) for libraries; public-entry contract tests live in `platform/analysis-engine/test/contract/public-entry.spec.ts` and `platform/shared/test/contract/public-entry.spec.ts`. Derive wire types from Zod in `platform/shared/`. Runtime must remain independent of `.claude/`, `scripts/`, and disposable `playground/`; `CLAUDE.md` and `scripts/check-isolation.ts` describe/check this separation.

Before dashboard code changes, read relevant installed Next documentation as required by `platform/dashboard/AGENTS.md`.

_Convention analysis: 2026-10-29_
