# LenGentic

**Agent Observability & Decision Intelligence Platform**

> LenGentic observes agent execution, analyzes historical decision patterns, and identifies
> evidence-backed candidates for deterministic defaults — while exposing counterexamples and
> uncertainty.

```
Observe  →  Store  →  Analyze  →  Recommend
```

> **Status: Phase 1 of 7.** The thesis spike (Phase 0) runs today and the platform boots
> end-to-end. Telemetry ingestion, the Run Explorer, and the analysis engine arrive in
> Phases 2–5. This README is rewritten as a Phase 7 deliverable (`p7.readme`).

---

## Quick start

Requires **Node 24** (`.nvmrc`; 22.13+ works), **pnpm 10+**, and **Docker** for the
database.

### 1. Install

```bash
pnpm install
cp .env.example .env
```

### 2. Run the thesis spike — no Docker, no database, no network

This is the fastest way to see what the product actually claims. Nine hand-written decision
groups run through five safety gates.

```bash
pnpm spike
```

```text
  GROUP   VERDICT      GATES FAILED            EXPECTATION
  D1@a1b  CANDIDATE    —                       MATCH
  ...
  D4@a1b  SUPPRESSED   G2                      MATCH
  D5@a1b  SUPPRESSED   G1                      MATCH

  10 groups   3 CANDIDATE   7 SUPPRESSED
  10/10 matched their declared expectation.
```

Seven of ten groups produce **nothing**, each naming the gate that suppressed it. That is
the feature. See [`spike/README.md`](spike/README.md).

### 3. Run the platform

```bash
docker compose up -d --wait
```

| Service   | URL                            | What it shows                 |
| --------- | ------------------------------ | ----------------------------- |
| Dashboard | <http://localhost:3000>        | Platform status page          |
| API       | <http://localhost:3001/health> | `200` healthy, `503` degraded |
| Postgres  | `localhost:5432`               | user/pass/db all `lengentic`  |

```bash
curl -fsS http://localhost:3001/health
docker compose down          # add -v to drop the volume
```

The API's health check is gated on a reachable database, so a healthy API here means
API-to-PostgreSQL connectivity genuinely works. This is the same sequence CI's `docker` job
runs on every push.

### 4. Or run it locally against Postgres in Docker

```bash
docker compose up -d postgres
export DATABASE_URL='postgresql://lengentic:lengentic@localhost:5432/lengentic?schema=public'
pnpm dev
```

`DATABASE_URL` must be in the shell: each package runs from its own directory, so the API
does not pick up the repository-root `.env`, and it validates its environment at boot rather
than at the first request. In PowerShell, `$env:DATABASE_URL = '...'`.

`prisma/schema.prisma` declares no models yet — Phase 1 proves the migration pipeline, not
the domain. `pnpm db:migrate` becomes meaningful in Phase 2, when `Run` and `Step` land.

### 5. Before you commit

```bash
pnpm gates        # lint, format, typecheck, test, build, boundaries, integrity
```

---

## The problem

An agent workflow with decisions, tools, retries, model calls, and failures becomes opaque
within a few dozen runs. Existing observability tells you _what happened_. LenGentic is
built to answer four questions:

```text
What happened?
Why did it happen?
Is this behavior repeating?
Can part of this probabilistic behavior become deterministic software?
```

The fourth is the interesting one, and it is where all of the risk lives.

## Why context diversity is the gate that matters

Given fifty observations where one option won 98% of the time, the obvious conclusion is
that the decision is trivial. It is not — not unless those fifty observations covered
_different situations_.

If all fifty share one context, 98% dominance says the agent kept encountering the same
situation. That is a property of the sample, not of the decision. Prior art in this area
promotes behaviors on sample count and consistency alone, which cannot distinguish "ten runs
of ten different situations" from "ten runs of one situation" — opposite findings that
produce identical numbers.

|                          | Progressive Crystallization | TraceCompiler             | LenGentic         |
| ------------------------ | --------------------------- | ------------------------- | ----------------- |
| Promotion gate           | ≥10 runs, ≥90% same actions | Argument-level provenance | Five gates, G1–G5 |
| Context-diversity gate   | No                          | No                        | **Yes — G2**      |
| Counterexample reporting | No                          | No — refuses to compile   | **Yes**           |

`G2 distinctContextCount >= 5` is why a decision group can be dominant, successful,
well-sampled, and still correctly produce nothing. TraceCompiler _refuses_ under
uncertainty; LenGentic _discloses_.

## Limits — what LenGentic cannot tell you

LenGentic observes **chosen options and attested outcomes**. It never observes
counterfactuals — it cannot know what would have happened had the agent chosen differently.

```text
LenGentic can say:

  "This decision selected X in N of M observed executions,
   across K distinct contexts, with an attested success
   rate of S%. Here are the M-N cases that did not."

LenGentic must never say:

  "This decision does not require an LLM."
```

- Outcomes are **attested**, never measured. The caller asserts them; LenGentic has no
  independent way to verify one.
- Every recommendation is a **hypothesis with counterevidence attached**, addressed to a
  human. The suggested action is a deterministic default with an escape hatch, never an
  unconditional replacement.
- `contextKey` is computed by the **caller**. The Platform groups by it and never infers it.
  A decision with no `contextKey` is stored and excluded from aggregation.
- **There is no demotion mechanism.** An accepted default that stops holding is not
  detected. Shadow mode in [`BACKLOG.md`](BACKLOG.md) is the honest future version.

## Architecture

Three separate systems, with mechanically enforced boundaries.

```
Engineering Harness  (.claude/)     builds the platform, never runs in it
        │ builds
        ▼
Platform             (platform/)    API · Database · Analysis Engine · Dashboard · SDK
        ▲ telemetry
        │
Playground           (playground/)  reference consumer: agents, providers, scenarios
```

The Platform must run correctly with `playground/` deleted. Both must run correctly with
`.claude/` deleted. Verified by `pnpm check:boundaries` and `pnpm check:isolation`, not by
review.

```text
platform/api            NestJS — ingestion, runs, analysis endpoints
platform/database       Prisma schema, migrations, client factory. Database-internal
platform/dashboard      Next.js — status page today, Run Explorer from Phase 2
platform/shared         Zod wire contract. The only source of cross-boundary types  (Phase 2)
platform/telemetry-sdk  The public artifact consumers install                        (Phase 2)
platform/analysis-engine  Aggregation, gates, analyzers                              (Phase 5)
playground/             Instrumented mock agent producing telemetry                  (Phase 3)
spike/                  Phase 0 thesis spike. Disposable; deleted end of Phase 5
```

`platform/shared/schema/**` is the single wire contract — SDK and API both derive types from
it with `z.infer`. Prisma types are database-internal and never cross a module boundary.

## Commands

| Command                 | Does                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm dev`              | API and Dashboard in watch mode                             |
| `pnpm gates`            | lint, format, typecheck, test, build, boundaries, integrity |
| `pnpm gates:full`       | `gates` plus `check:isolation` (slow; CI and pre-commit)    |
| `pnpm check:boundaries` | dependency-cruiser architectural rules                      |
| `pnpm check:isolation`  | builds the platform with `playground/` removed              |
| `pnpm check:integrity`  | false green, focused tests, hidden skips                    |
| `pnpm test:integration` | Testcontainers-backed integration suite (needs Docker)      |
| `pnpm spike`            | Phase 0 thesis spike                                        |
| `pnpm db:migrate`       | Prisma migration (meaningful from Phase 2)                  |

Engineering-harness commands — `pnpm oracle`, `pnpm lanes`, `pnpm check:lanes` — read
`.claude/` and are documented in [`docs/PARALLEL_EXECUTION.md`](docs/PARALLEL_EXECUTION.md).
They are deliberately outside `pnpm gates`, which must keep working with the harness
deleted.

## Documentation

| File                                                       | What it is                                      |
| ---------------------------------------------------------- | ----------------------------------------------- |
| [`MVP_PLAN_V3.md`](MVP_PLAN_V3.md)                         | The single executable plan. Seven phases        |
| [`CONTEXT.md`](CONTEXT.md)                                 | Shared vocabulary — one term, one meaning       |
| [`CLAUDE.md`](CLAUDE.md)                                   | Project rules binding every agent and session   |
| [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)         | Generated deliverable matrix and phase progress |
| [`docs/PARALLEL_EXECUTION.md`](docs/PARALLEL_EXECUTION.md) | Work packets, waves, lanes, dispatch            |
| [`BACKLOG.md`](BACKLOG.md)                                 | Deferred work, with its source                  |

`MVP_PLAN.md` (v2) and `docs/superpowers/specs/` are historical. v3 absorbed them and wins
on any conflict.
