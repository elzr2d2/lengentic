# CLAUDE.md

Project rules for LenGentic. These bind every agent and every session.

## Plan discipline

Follow `MVP_PLAN.md`.

Where `MVP_PLAN.md` and
`docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md` disagree, the
corrections document wins. It records defects found in review, and each correction names
the section it replaces.

Work on one phase at a time.

Never automatically begin the next MVP phase.

Do not redesign the approved MVP while implementing it.

Anything valuable but unnecessary for the current phase goes into `BACKLOG.md`.

Prefer the simplest solution satisfying the current Definition of Done.

Every completed phase must leave the repository runnable.

## Architecture

Platform and Playground must remain independent.

Platform must never import Playground code.

`playground/**` may import `platform/telemetry-sdk` through its public entry only. Never
`platform/api/**` or `platform/analysis-engine/**`.

`platform/telemetry-sdk` may import `platform/shared` and nothing else from the platform.
The SDK is the public artifact; a transitive Prisma dependency would make every consumer
install a database client to emit telemetry.

`.claude/` is engineering infrastructure only.

Engineering Agents must never become runtime dependencies. LenGentic must run correctly if
`.claude/` is deleted, and the Platform must run correctly if the entire Playground is
deleted.

## Types

`platform/shared/schema/**` holds Zod schemas and is the **only** wire contract. The SDK
and the API both import it; types are derived with `z.infer`.

Prisma types are database-internal and never cross a module boundary. No Prisma model is
ever returned from a controller. Map explicitly at the persistence edge.

## Verification

Mechanical checks are tooling, not agents. Never ask an agent to verify something a script
can verify.

Forbidden imports and architectural boundaries are `pnpm check:boundaries`. Reviewer does
not check them.

Validation agents report evidence instead of silently repairing implementation.

Validation agents return findings as JSON matching `.claude/rules/handoff.schema.json`.

## Product claims

Recommendations are hypotheses with counterevidence, never assertions.

Say "attested success rate", never "measured success rate". The caller asserts the outcome;
LenGentic has no independent way to verify it.

LenGentic observes chosen options and attested outcomes. It does not observe
counterfactuals. It may never claim a decision "does not require an LLM".

Every deterministic recommendation carries a `counterexamples` field. The field may be
empty; it is never omitted.

When implementing analyzers, write the negative fixtures before the positive path. False
positives are the failure mode that kills a recommendations product.

## Commands

```bash
pnpm gates              # lint, format, typecheck, test, build, boundaries
pnpm gates:full         # gates + check:isolation (slow; CI and pre-commit only)
pnpm check:boundaries   # dependency-cruiser
pnpm check:isolation    # builds the platform with playground/ deleted
pnpm spike              # Phase 0 thesis spike (disposable, deleted end of Phase 5)
```

## Current state

Phase 0 complete — thesis validated, all nine fixture groups produce agreed verdicts.
Phase 1 in progress.
