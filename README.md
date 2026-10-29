# LenGentic

**Agent Observability & Decision Intelligence Platform**

> LenGentic observes agent execution, analyzes historical decision patterns, and identifies
> evidence-backed candidates for deterministic defaults — while exposing counterexamples and
> uncertainty.

```text
Observe  →  Store  →  Analyze  →  Recommend
```

## The differentiator: G2, the context-diversity gate

Ten runs of the same situation and ten runs of ten different situations are indistinguishable
under a pure dominance gate, and they are _opposite_ findings. If fifty samples all share one
`contextKey`, 98% dominance says the agent kept meeting the same situation. That is a property
of the sample, not of the decision.

LenGentic's gate **G2** (`distinctContextKeyCount >= minDistinctContexts`, default 5) turns
"this option wins" into "this option wins **across varied situations**" — the only version of
the claim that supports a deterministic default. A decision group can be dominant, have a high
attested success rate, be well sampled, and still correctly produce **nothing**, because it
only ever saw two situations. In the demo below, exactly that group is shown being refused.

Two adjacent systems implement neighbouring theses — Progressive Crystallization and
TraceCompiler. Neither has a context-diversity gate, and neither reports counterexamples
alongside what it promotes. The comparison, recorded verbatim from the plan, is under
**Position against prior art** in the next section.

## Epistemic position and prior art

_The text below is `MVP_PLAN_V3.md` §2, copied verbatim. It constrains every claim the product
makes._

This section constrains every claim the product makes. It is not boilerplate.

LenGentic observes **chosen options and attested outcomes**. It does not observe
counterfactuals.

```text
LenGentic can say:

  "This decision selected X in N of M observed executions,
   across K distinct contexts, with an attested success
   rate of S%. Here are the M-N cases that did not."

LenGentic must never say:

  "This decision does not require an LLM."
```

Every recommendation is a **hypothesis with attached evidence and counterevidence**,
addressed to a human. The suggested action is always a deterministic default with an escape
hatch, never unconditional replacement.

Say **"attested success rate"**, never "measured success rate". The caller asserts the
outcome; LenGentic has no independent way to verify it.

### Position against prior art

Two systems implement adjacent theses. Recorded because the differentiator is narrow and
must be stated precisely.

|                              | Progressive Crystallization                    | TraceCompiler                       | LenGentic         |
| ---------------------------- | ---------------------------------------------- | ----------------------------------- | ----------------- |
| Promotion gate               | ≥10 successful runs, ≥90% same action sequence | Argument-level provenance           | Five gates, G1–G5 |
| **Context-diversity gate**   | **No**                                         | **No**                              | **Yes — G2**      |
| **Counterexample reporting** | **No**                                         | **No** — refuses to compile instead | **Yes**           |
| Regression handling          | Circuit-breaker demotion                       | Not addressed                       | **None (MVP)**    |

Two consequences:

1. **G2 is the differentiator.** Ten runs of the same situation and ten runs of ten
   different situations are indistinguishable under a pure dominance gate, and they are
   _opposite_ findings. G2 separates them.
2. **Counterexample reporting is unclaimed.** TraceCompiler _refuses_ under uncertainty;
   LenGentic _discloses_. Refusal hides the judgment call from the engineer; disclosure
   hands it to them.

Recorded non-goal, for honesty: LenGentic has **no demotion mechanism**. An accepted default
that stops holding is not detected. The README's limits section must say so. `BACKLOG.md`'s
shadow mode is the honest future version.

## Limits

What LenGentic cannot tell you, and what it does not do.

- **There is no demotion mechanism.** An accepted default that stops holding is not detected.
  LenGentic does not track whether a recommendation was accepted, and it does not watch a
  deterministic default after the fact. Progressive Crystallization has a circuit-breaker
  demotion; LenGentic has nothing equivalent in the MVP. Shadow mode in
  [`BACKLOG.md`](BACKLOG.md) — running the deterministic default alongside the LLM decision and
  comparing — is the honest future version.
- **No counterfactuals.** LenGentic sees chosen options and attested outcomes. It never learns
  what would have happened had the minority option been chosen. That is why the minority
  branch is reported rather than averaged away, and why the suggested action is a default with
  an escape hatch rather than a replacement.
- **Outcomes are attested.** The caller asserts the outcome; LenGentic has no independent way
  to verify it. Every success figure in the product is an _attested success rate_.
- **Recommendations are hypotheses**, with counterevidence attached, addressed to a human.
  Nothing is applied automatically, and LenGentic does not "learn" — no learning system is
  implemented.
- **`contextKey` is computed by the caller.** The platform groups by it and never infers it. A
  decision with no `contextKey` is stored and excluded from aggregation.
- **Analysis is explicit and on demand.** There is no background analysis worker. Suppressed
  groups are returned by the analysis response and are never stored, so a refusal is visible
  only on the response that produced it.
- **Local, single-tenant, unauthenticated.** No authentication, multi-tenancy, OpenTelemetry
  integration or cloud deployment (`MVP_PLAN_V3.md` §26).
- **The Playground is simulated.** Its agents and providers are mocks that emit telemetry
  through the SDK. The platform runs correctly with `playground/` deleted.

## Quick start

Requires **Node 24** (`.nvmrc`; 22.13+ works), **pnpm 10+**, and **Docker**.

```bash
git clone <repository>
cd <repository>
cp .env.example .env
pnpm install
docker compose up -d --wait
pnpm playground:happy-path
```

A Run appears in the Dashboard at <http://localhost:3000/runs>.

`docker compose up -d --wait` builds the images, starts Postgres, applies the committed
migrations in a one-shot `migrate` service, then starts the API and Dashboard. `--wait` returns
once they are healthy. Drop `-d --wait` to follow the logs in the foreground.

| Service   | URL                            | What it shows                               |
| --------- | ------------------------------ | ------------------------------------------- |
| Dashboard | <http://localhost:3000>        | Platform status, Runs, Recommendations      |
| API       | <http://localhost:3001/health> | `200` healthy, `503` degraded               |
| Postgres  | `localhost:5432`               | user, password and database all `lengentic` |
| `migrate` | —                              | one-shot; applies migrations and exits      |

```bash
curl -fsS http://localhost:3001/health
docker compose down          # add -v to drop the database volume
```

The API's health check is gated on a reachable database, so a healthy API means
API-to-PostgreSQL connectivity works. Playground commands send telemetry to
`http://localhost:3001`; set `PLAYGROUND_ENDPOINT` to point them elsewhere.

### No Docker? The thesis spike

```bash
pnpm spike       # no Docker, no database, no network
```

Ten hand-written decision groups run through the five safety gates; seven of ten produce
nothing, each naming the gates that suppressed it. See [`spike/README.md`](spike/README.md).

### Run the services locally against Postgres in Docker

```bash
docker compose up -d --wait postgres
export DATABASE_URL='postgresql://lengentic:lengentic@localhost:5432/lengentic?schema=public'
pnpm db:migrate
pnpm dev
```

`DATABASE_URL` must be in the shell: each package runs from its own directory, so the API does
not read the repository-root `.env`, and it validates its environment at boot. In PowerShell,
`$env:DATABASE_URL = '...'`.

## The demo

Eight beats, from a clean clone. Beats 1 and 2 are commands; the rest is the Dashboard.

```bash
docker compose up -d --wait
pnpm playground:deterministic-decision
```

1. **`docker compose up`** — Postgres, migrations, API, Dashboard (see Quick start).
2. **`pnpm playground:deterministic-decision`** — one command, two cohorts of simulated runs
   sent through the Telemetry SDK. It prints what it emitted and **no verdict**; the verdict
   comes from the analyzer. Add `--seed=<integer>` to change the seed (default `42`).

   | Cohort      | Workflow                   | Samples | Distinct contexts | Selections       |
   | ----------- | -------------------------- | ------- | ----------------- | ---------------- |
   | `candidate` | `demo-workflow`            | 36      | 9                 | `YES` 34, `NO` 2 |
   | `control`   | `batch-iteration-workflow` | 30      | 2                 | `YES` 29, `NO` 1 |

   Re-running with the same seed records nothing new; the command says so.

3. **Runs list** — <http://localhost:3000/runs>. Many Runs, one per emitted sample.
4. **Run detail** — open any Run. The page shows its execution timeline, Steps (as the tree
   their `parentStepId`s describe), Decisions, Tool calls, Model calls and ingestion health.
5. **Explicit analysis trigger** — <http://localhost:3000/recommendations>, then press
   **Analyze**. This performs `POST /v1/analysis/run` over every Run recorded so far:

   ```bash
   curl -fsS -X POST http://localhost:3001/v1/analysis/run     # the same call, without the UI
   ```

6. **Decision History** — one row per decision group: samples, distinct contexts, the
   selected-option split, and the attested success rate. The `candidate` group is
   `demo-workflow`'s `YES`/`NO` decision.
7. **The recommendation, counterexamples included** — the `candidate` group clears G1–G5 and
   becomes a `DETERMINISTIC_CANDIDATE`. It carries its counterexamples: the dominant option's
   attested failures and the minority option's attested successes, with where the minority
   cases concentrate. The suggested action is a deterministic default with an escape hatch.
8. **The closing move: the suppressed group.** The same command already emitted the
   batch-iteration workload. LenGentic produced **no recommendation** for it. The analysis
   result lists it as `SUPPRESSED`, with the gate that failed named:

   ```text
   Verdict: SUPPRESSED
   Gates:   G2 context_diversity  (2 < 5)
   ```

   It has enough samples, a dominant option and a high attested success rate. It saw two
   situations. A tool that produces recommendations is unremarkable; one that demonstrably
   declines to produce bad ones is the point.

Every failed gate is reported, not the first one. `pnpm playground:repeated-failure` emits a
different scenario — a repeated failed action — that the analyzer reports as a
`REPEATED_FAILED_ACTION` recommendation.

## The five safety gates

All must pass; every threshold is configurable. A group failing any gate is `SUPPRESSED` and the
report lists **every** failing gate.

```text
G1  sampleCount                          >= minSampleCount        default 30
G2  distinctContextKeyCount              >= minDistinctContexts   default 5
G3  dominancePercentage                  >= dominanceThreshold    default 90%
G4  dominantOptionAttestedSuccessRate    >= successThreshold      default 90%
G5  outcomeCoverage                      >= coverageThreshold     default 80%
```

G4 evaluates the dominant option specifically: a blended attested success rate across all
options can clear the gate while the option being recommended is the one that fails.

## Architecture

Three separate systems, with mechanically enforced boundaries.

```text
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
platform/api              NestJS — telemetry ingestion, runs, analysis, recommendations
platform/database         Prisma schema, migrations, client factory. Database-internal
platform/dashboard        Next.js — status, Run Explorer, Decision History, Recommendations
platform/shared           Zod wire contract. The only source of cross-boundary types
platform/telemetry-sdk    The public artifact consumers install
platform/analysis-engine  Aggregation, gates, analyzers
playground/               Instrumented mock agents and scenarios producing telemetry
spike/                    Phase 0 thesis spike, kept as the record of the original grid
```

`platform/shared/schema/**` is the single wire contract — SDK and API both derive types from it
with `z.infer`. Prisma types are database-internal and never cross a module boundary.

## Commands

| Command                                  | Does                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `pnpm dev`                               | API and Dashboard in watch mode                             |
| `pnpm playground:happy-path`             | One five-step mock-agent run through the SDK                |
| `pnpm playground:repeated-failure`       | Scenario 2: a repeated failed action                        |
| `pnpm playground:deterministic-decision` | Scenario 3: a candidate cohort and a low-diversity control  |
| `pnpm spike`                             | Phase 0 thesis spike; no Docker, database or network        |
| `pnpm gates`                             | lint, format, typecheck, test, build, boundaries, integrity |
| `pnpm gates:full`                        | `gates` plus `check:isolation` (slow; CI and phase gate)    |
| `pnpm check:boundaries`                  | dependency-cruiser architectural rules                      |
| `pnpm check:isolation`                   | builds the platform with `playground/` removed              |
| `pnpm check:integrity`                   | false green, focused tests, hidden skips                    |
| `pnpm test:integration`                  | Testcontainers-backed integration suite (needs Docker)      |
| `pnpm db:migrate`                        | Prisma `migrate dev` against `DATABASE_URL`                 |
| `pnpm db:reset` / `pnpm db:seed`         | Reset the database / run the seed                           |

Engineering-harness commands — `pnpm oracle`, `pnpm lanes`, `pnpm flow`, `pnpm check:lanes` —
read `.claude/` and are documented in [`docs/PARALLEL_EXECUTION.md`](docs/PARALLEL_EXECUTION.md).
`pnpm kb search <words>` ranks every markdown section and returns `file:line`;
`pnpm kb show §19` prints one section verbatim. All of them are deliberately outside
`pnpm gates`, which must keep working with the harness deleted.

Before you commit:

```bash
pnpm gates
```

## Documentation

| File                                                             | What it is                                    |
| ---------------------------------------------------------------- | --------------------------------------------- |
| [`MVP_PLAN_V3.md`](MVP_PLAN_V3.md)                               | The single executable plan. Seven phases      |
| [`CONTEXT.md`](CONTEXT.md)                                       | Shared vocabulary — one term, one meaning     |
| [`CLAUDE.md`](CLAUDE.md)                                         | Project rules binding every agent and session |
| [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md) | Coding standards and their enforcers          |
| [`docs/PARALLEL_EXECUTION.md`](docs/PARALLEL_EXECUTION.md)       | Work packets, waves, lanes, dispatch          |
| [`docs/decisions/`](docs/decisions/)                             | Architecture decision records                 |
| [`BACKLOG.md`](BACKLOG.md)                                       | Deferred work, with its source                |

`MVP_PLAN.md` (v2) and `docs/superpowers/specs/` are historical. v3 absorbed them and wins on
any conflict.
