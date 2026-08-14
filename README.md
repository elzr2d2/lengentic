# LenGentic

**Agent Observability & Decision Intelligence Platform**

LenGentic observes how agents behave, learns from their historical decisions, and
identifies where probabilistic behavior can become reliable software — while showing its
work, including the evidence against its own conclusions.

```
Observe  →  Store  →  Analyze  →  Recommend
```

> **Status: Phase 1 of 7.** Phase 0 (thesis spike) is complete. The sections below marked
> _planned_ do not exist yet. This file grows into the full README in Phase 7 (§90).

---

## The problem

An agent workflow with decisions, tools, retries, model calls, and failures becomes
opaque within a few dozen runs. Existing observability tells you _what happened_. LenGentic
is built to answer four questions:

```
What happened?
Why did it happen?
Is this behavior repeating?
Can part of this probabilistic behavior become deterministic software?
```

The fourth is the interesting one, and it is where most of the risk lives.

## What LenGentic cannot tell you

LenGentic observes **chosen options and attested outcomes**. It never observes
counterfactuals — it cannot know what would have happened had the agent chosen
differently.

So it can say:

> This decision selected `YES` in 49 of 50 observed executions, across 12 distinct
> contexts, with an attested success rate of 95.7%. Here is the one case that did not.

And it must never say:

> This decision does not require an LLM.

Every recommendation is a hypothesis with evidence _and counterevidence_, addressed to a
human. The suggested action is always a deterministic default with an escape hatch, never
an unconditional replacement. That distinction is the difference between a tool an engineer
trusts and one they mute after the third false positive.

## Why context diversity is the gate that matters

Given fifty observations where one option won 98% of the time, the obvious conclusion is
that the decision is trivial. It is not — not unless those fifty observations covered
_different situations_.

If all fifty share one context, 98% dominance says the agent kept encountering the same
situation. That is a property of the sample, not of the decision. Published work in this
area promotes behaviors on sample count and consistency alone, which cannot distinguish
"ten runs of ten different situations" from "ten runs of one situation" — opposite findings
that produce identical numbers.

LenGentic gates on it. `G2 distinctContextCount >= 5` is why a decision group can be
dominant, successful, well-sampled, and still correctly produce nothing.

## Phase 0 — thesis spike

```bash
pnpm spike
```

Nine hand-written decision groups, five safety gates, no database or network. Three
produce a recommendation; six are suppressed, each naming the gate that suppressed it. See
[`spike/README.md`](spike/README.md).

`spike/` is disposable and is deleted at the end of Phase 5. Its pure functions and
fixtures are not — they graduate into `platform/analysis-engine`.

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
`.claude/` deleted. These are verified by `pnpm check:boundaries` and
`pnpm check:isolation`, not by review.

## Quick start

Requires **Node 22.13+** (24 LTS recommended) and **pnpm 10+**.

```bash
pnpm install
```

_Docker setup, database, and the running platform arrive later in Phase 1._

## Commands

| Command                 | Does                                             |
| ----------------------- | ------------------------------------------------ |
| `pnpm gates`            | lint, format, typecheck, test, build, boundaries |
| `pnpm gates:full`       | `gates` plus `check:isolation`                   |
| `pnpm check:boundaries` | dependency-cruiser architectural rules           |
| `pnpm check:isolation`  | builds the platform with `playground/` removed   |
| `pnpm spike`            | Phase 0 thesis spike                             |

## Documentation

- [`MVP_PLAN.md`](MVP_PLAN.md) — the seven-phase plan
- [`docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md`](docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md)
  — review findings and locked decisions. Wins over `MVP_PLAN.md` on conflict
- [`BACKLOG.md`](BACKLOG.md) — deferred work
- [`CLAUDE.md`](CLAUDE.md) — project rules for agents
