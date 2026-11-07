# Codebase Structure

**Analysis Date:** 2026-10-29

## Directory Layout

```text
platform/
  shared/             Zod wire/read contracts
  telemetry-sdk/      Public producer-facing telemetry library
  api/                Nest HTTP API and persistence orchestration
  database/           Prisma schema, migrations, generated client factory
  analysis-engine/    Pure record aggregation and analyzers
  dashboard/          Next.js App Router UI
playground/           Independent SDK-consuming mock agents and scenarios
spike/                Thesis spike, retained as historical evidence
scripts/              Gates, oracle, flow, lanes, knowledge retrieval, autopilot
.claude/              Engineering-harness agents, skills and rules
.autopilot/           Supervisor runtime artifacts
.artifacts/           Captured validation and execution evidence
docs/                 Standards, decisions, research and historical specs
.planning/codebase/   Derived current-state reference map
```

## Directory Purposes

- `platform/shared/schema/`: event envelopes, per-entity payloads, ingest and recommendation schemas. `platform/shared/read/` contains read-view contracts. Public entries are `platform/shared/index.ts` and `platform/shared/read/index.ts`.
- `platform/api/src/`: feature modules (`telemetry`, `runs`, `decisions`, `model-call`, `tool-call`, `error`, `analysis`, `recommendations`), plus `common`, `config`, `health`, `prisma` infrastructure.
- `platform/database/prisma/`: schema, committed migrations and seed. Client construction is `platform/database/src/index.ts`; generation/build caching is `platform/database/scripts/build-if-changed.mjs`.
- `platform/analysis-engine/src/`: aggregation, gates, types, config and repeated failed actions. Independent fixture inputs/expectations live under `platform/analysis-engine/fixtures/`.
- `platform/dashboard/src/app/`: overview, run list/detail and recommendations. Shared API functions and telemetry transforms live in `platform/dashboard/src/lib/`.
- `playground/`: `providers`, `agents`, `workflows`, `strategy`, `determinism`, `cli`, `scenarios`. Scenario main files are executable producer entry points.
- `docs/decisions/`: architecture decisions; `docs/research/`: dated external research; `docs/ENGINEERING_STANDARDS.md`: standards authority.

## Key File Locations

**Entry points:** `platform/api/src/main.ts`, `platform/api/src/app.module.ts`, `platform/dashboard/src/app/layout.tsx`, `platform/telemetry-sdk/src/index.ts`, `platform/analysis-engine/src/index.ts`.

**Configuration:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.dependency-cruiser.cjs`, `platform/dashboard/next.config.ts`.

**Roadmap/context:** `MVP_PLAN_V3.md` is the executable roadmap; `CONTEXT.md` owns shared terminology; `BACKLOG.md` holds deferred work. `MVP_PLAN.md` and `docs/superpowers/specs/` are historical (`CLAUDE.md`).

**Execution status/retrieval:** `scripts/oracle/graph.json`, `scripts/oracle.ts`, `scripts/flow.ts`, `scripts/kb.ts`. Use `pnpm oracle status`, `pnpm flow next`, and targeted `pnpm kb show/search`; do not treat this static map as runtime status.

**Tests:** API unit tests beside source (`*.spec.ts`); API integration under `platform/api/test/`; engine tests under `platform/analysis-engine/test/`; SDK tests under `platform/telemetry-sdk/test/`; dashboard helpers/components have nearby specs.

## Naming Conventions

- Kebab-case TypeScript files; Nest role suffixes such as `analysis.controller.ts`, `analysis.service.ts`, `analysis.repository.ts`, `analysis.module.ts` (`platform/api/src/analysis/`).
- React route entries use Next.js names `page.tsx` and `layout.tsx`; dynamic route segment `[id]` (`platform/dashboard/src/app/runs/[id]/`).
- Public package entries export explicit surfaces (`platform/analysis-engine/src/index.ts`, `platform/telemetry-sdk/src/index.ts`).

## Where to Add New Code

- New telemetry event: shared schema/export first; SDK emitter, API validation/mapping and owning entity repository afterward. Match existing `platform/shared/schema/tool-call-events.ts` and `platform/api/src/tool-call/`.
- New pure analyzer: `platform/analysis-engine/src/`, independent fixtures under `fixtures/`, observable tests under `test/`. Add persistence/orchestration only in `platform/api/src/analysis/` and `recommendations/`.
- New dashboard view: `platform/dashboard/src/app/`; API access belongs in `src/lib/` and must consume shared contracts. Read `platform/dashboard/AGENTS.md` before editing Next.js code.
- New schema migration: `platform/database/prisma/migrations/`; regenerate through package scripts.
- New demonstration: `playground/scenarios/`, importing only the SDK public API. Never make `platform/` import the demonstration.
- New harness behavior: `scripts/` plus its selftests; keep it outside runtime dependencies (`CLAUDE.md`).

## Special Directories

- `platform/database/src/generated/`: Prisma-generated client; derive via build/generation, do not hand-edit (`platform/database/src/index.ts`, package scripts).
- Package `dist/`, `.next/`, `node_modules/`: generated outputs/dependencies, not source authorities.
- `.planning/codebase/`: derived reference documentation; update after architectural changes, preserving links to authoritative sources.
- `.artifacts/` and `.autopilot/`: inspect dated evidence deliberately; file existence alone does not prove a current acceptance criterion.

_Structure analysis: 2026-10-29; static source inspection._
