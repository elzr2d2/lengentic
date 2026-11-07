# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LenGentic: agent observability and decision-intelligence platform (`Observe → Store → Analyze → Recommend`). pnpm monorepo, TypeScript, Node ≥22.13, pnpm ≥10, Postgres via Docker.

## Commands

```bash
pnpm gates              # build, lint, format:check, typecheck, test, boundaries, integrity
pnpm gates:full         # gates + check:isolation (slow; phase gate and CI)
pnpm lint | format:check | typecheck | test | build
pnpm check:boundaries   # dependency-cruiser (.dependency-cruiser.cjs)
pnpm check:isolation    # builds platform with playground/ deleted
pnpm check:integrity    # QA-integrity scan: false green, focused tests, hidden skips
pnpm --filter @lengentic/api test <substring>   # one vitest file, by path substring
pnpm spike              # Phase 0 thesis spike; no Docker/DB/network
pnpm playground:happy-path | playground:repeated-failure | playground:deterministic-decision
docker compose up -d --wait   # dashboard :3000, api :3001/health, postgres :5432
pnpm db:migrate | db:reset | db:seed
```

`typecheck` and `test` build `@lengentic/database` first (generated Prisma client).

Engineering-harness commands (read `.claude/`, plan docs, `scripts/oracle/graph.json`):

```bash
pnpm flow next          # the one next action as JSON: DISPATCH | WAVE_GATE | INTEGRATE | REPAIR | PHASE_GATE | ADVANCE_PHASE | BLOCKED | COMPLETE
pnpm lanes wave <n>     # sequential-vs-parallel decision (plain phase number: `5`, not `5a`)
pnpm lanes check <id> | handoff <f> | integrate
pnpm oracle status | waves | packet <id>
pnpm autopilot          # unattended supervisor loop (--dry-run, status, doctor, stop, resume)
pnpm kb search <words> | show <§19|phase 5|FILE.md#heading> | term <name> | stale
pnpm check:lanes | check:flow | check:kb | check:autopilot | check:probes   # harness selftests; deliberately outside `pnpm gates`
```

## Architecture

- `platform/` — `shared` (Zod schemas = the only wire contract), `telemetry-sdk` (public artifact), `api`, `analysis-engine`, `database` (Prisma), `dashboard`.
- `playground/` — simulated agents/scenarios that emit telemetry through the SDK; the platform must run with it deleted.
- `spike/` — Phase 0 thesis spike, kept on purpose as the record of where it disagrees with the corrected grid.
- `.claude/`, `scripts/` — engineering harness (agents, skills, rules, oracle/flow/lanes/autopilot). Never a runtime dependency; the product must run with `.claude/` deleted.

Boundary rules (enforced by `pnpm check:boundaries`):

- Platform never imports Playground. Playground imports `platform/telemetry-sdk` via its public entry only (never `api/**` or `analysis-engine/**`).
- `telemetry-sdk` may import `platform/shared` only (no transitive Prisma).
- Types derive from Zod via `z.infer`. Prisma types never cross a module boundary; map explicitly at the persistence edge, never return a Prisma model from a controller.

## Product claims (binding)

- Say "attested success rate", never "measured": the caller asserts the outcome.
- LenGentic sees chosen options and attested outcomes, not counterfactuals; never claim a decision "does not require an LLM".
- Every deterministic recommendation carries `counterexamples` (may be empty, never omitted). Write negative fixtures before the positive path in analyzers.

## Plan and process

- `MVP_PLAN_V3.md` is the single executable plan (~24k tokens); `MVP_PLAN.md` (v2) and `docs/superpowers/specs/**` are historical. `BACKLOG.md` is ~16k tokens. Don't read either whole — use `pnpm kb search` / `pnpm kb show`. Retrieval confers no authority; `[HISTORICAL]`/`[STALE]` hits are pointers only.
- `CONTEXT.md` is the shared vocabulary (`attested`, `counterexample`, `contextKey`, seam, work packet, wave, "green that lies"). Read it when naming or judging correctness.
- `docs/ENGINEERING_STANDARDS.md` is the coding-standards SSOT (each rule names its enforcing command or owning role). Read before writing code; don't restate its rules elsewhere. `docs/decisions/` = ADRs; `docs/research/` = expiring external facts (check `review-by`).
- Execution order: `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`. One phase at a time; phase gates are validation gates, not approval gates. Valuable-but-out-of-scope ideas go to `BACKLOG.md`.
- Escalate to the human only on: destructive/irreversible action; material scope or architecture change; high-impact decision with no inferable preference; credentials/cost/production/security/privacy/legal; a gate failing after two distinct recovery attempts; genuinely conflicting requirements. Otherwise decide from the rules, document the assumption, prefer the reversible option.
- Dispatch is sequential by default; start from `pnpm flow next`. Subagents get a work packet (`pnpm oracle packet <id>`), not "read the plan". A lane writes only inside its `allowed_paths`. Worktrees/branches are never deleted automatically.
- `DONE` is a claim about evidence: each acceptance criterion needs its own expected/actual/result (`.claude/rules/lane-handoff.schema.json`, `pnpm lanes handoff`); validation findings follow `.claude/rules/handoff.schema.json`. A green `pnpm gates` alone is not GREEN.
- Mechanical checks are scripts, not agents; run the gates before dispatching a validation agent.
- Oracle probes may only inspect the surface their own node owns (`pnpm check:probes`), else a packet reports DONE before it starts.
- Runtime status never lives in this file: use `pnpm oracle status`.

## Communication

Extremely concise; fragments over prose. Never omit failures, uncertainty, blockers or validation evidence; quote captured output (commands, exit codes, stack traces) verbatim. Put detail in `.artifacts/` and return paths. Plans: concise, end with unresolved questions, last section = numbered steps. Progress and failure reporting: skill `structured-logging`.
