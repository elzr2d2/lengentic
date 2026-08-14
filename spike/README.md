# Phase 0 — Thesis Spike

**Disposable.** This directory is deleted at the end of Phase 5 (`MVP_PLAN.md` §75).
The pure functions and the fixtures are not disposable — they graduate into
`platform/analysis-engine` and its test suite (§13, §74).

## What this answers

> Does decision aggregation produce recommendations that a competent engineer agrees with?

That question needs no database, no API, no dashboard, and no agents. It needs a function
and some fixtures. If the answer is no, the thesis dies here for the price of a day
instead of after four phases of infrastructure built to serve it.

## Run

```bash
npm run spike     # pnpm spike once Node 22 LTS is installed — see BACKLOG.md
```

Exit code is `0` when every fixture matches its declared expectation, `1` otherwise.

## Layout

| File | Role |
|---|---|
| `fixtures/decisions.json` | Nine hand-written decision groups, each declaring its expected verdict |
| `expand.ts` | Turns a declared group into decision records. No counting, no gates |
| `aggregate.ts` | Grouping, exclusions, and metrics. Pure |
| `gates.ts` | G1–G5, each an independent function of `(aggregate, config)`. Pure |
| `config.ts` | Thresholds. Every one configurable |
| `report.ts` | Text rendering. Pure |
| `main.ts` | The only impure file: read fixtures, print, set exit code |

## The real gate

`MVP_PLAN.md` §13's checklist ends with:

> **You read all 8 verdicts and agree with each one.**

That is the actual gate. Machine agreement between the fixtures and the code proves only
that the code does what the fixtures say. If a verdict is defensible to the code and wrong
to a competent engineer, the thresholds or the gate set are wrong, and they get fixed
here — where fixing them costs an hour instead of a migration.

## Two corrections applied

Both are recorded in `docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md`.

1. **`contextKey` is not part of the group key** (§70 as written pinned
   `distinctContextCount` to 1, making G2 unsatisfiable).
2. **`UNKNOWN`-outcome decisions count toward `sampleCount`** (excluding them pinned
   `outcomeCoverage` to 100%, making G5 unsatisfiable).

Both were gates that could never fail. `D4` and `D7` exist to keep them that way.
