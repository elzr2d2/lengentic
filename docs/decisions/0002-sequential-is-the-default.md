---
number: 0002
title: Sequential dispatch is the default, and unknown counts as false
date: 2026-08-16
status: accepted
---

Backfilled 2026-08-16 from `docs/PARALLEL_EXECUTION.md` §10 and `CLAUDE.md`, where this
rule was already stated and enforced before `docs/decisions/` existed.

## Context

Parallel dispatch of work packets is faster when it works and expensive when it does not.
`docs/PARALLEL_EXECUTION.md` names the worst case plainly: "Two Builders editing
`platform/api/src` concurrently is the most expensive failure mode available."

The judgement call — is this batch safe to parallelise? — is exactly the kind a model
makes confidently and wrongly, because the evidence for safety (no overlapping writes, no
unfrozen contract, independent validation) is spread across a dependency graph nobody
holds in their head.

## Decision

Parallelism is never decided by judgement. `CLAUDE.md:99` states it:

> Never dispatch by judgement. Run `pnpm lanes wave <phase>` and follow the
> `execution_decision`.

The gate is fifteen hard requirements (R1-R15) evaluated by `scripts/lanes.ts`, and the
default resolves the wrong way on purpose. `docs/PARALLEL_EXECUTION.md:288`:

> **Sequential is the default and unknown counts as false.** A requirement nobody checked
> is not a requirement that passed.

Annotation is the opt-in, not the opt-out. A node with no `validate` array and no
`own.allowed` fails R3, R7 and R10 and runs sequentially. Nothing becomes parallel by
being forgotten.

## Consequences

- **Slower by default, and deliberately so.** Default `lanePolicy.maxConcurrency` is 2.
  Peak useful parallelism is stated as three. Dispatching wider than the wave does not go
  faster.
- **Annotation is real work.** Every deliverable that should ever run in parallel must
  carry declared paths and validation commands in `scripts/oracle/graph.json`, up front.
- **Overlap checking is conservative**, so some genuinely safe batches will be refused.
  Accepted: a false sequential costs wall-clock, a false parallel costs a conflicted merge
  plus the review to find it.
- **R12 rests on an unmeasured quantity.** "Estimated benefit exceeds overhead" is a count
  heuristic; real overhead in tokens is not measured. Open, with a named trigger, at
  `BACKLOG.md:249`.

The same rule is the product's, not only the harness's. `CONTEXT.md:82` defines **Unknown
is false** as a domain term: "Any `unknown` forces the safe sequential fallback. The same
rule the harness applies in `scripts/lanes.ts`." The engineering harness and the
`execution_strategy` evaluator (§29) share one epistemic stance.

## Detection

Two ways this shows itself wrong, both already instrumented:

1. **Too conservative.** `.artifacts/telemetry/lanes.jsonl` records every `decide` event
   with its blockers. A blocker that fires repeatedly on batches later integrated without
   incident is a requirement that is mis-specified, not a batch that was unsafe.
2. **Not conservative enough.** Any lane collision that reaches integration despite an
   `eligible: true` verdict falsifies the gate directly. `pnpm lanes integrate` is the
   place it would surface.

Known uncovered case, blocking parallel in Phase 2: "Misrouting under parallel dispatch is
uncovered" (`BACKLOG.md`, 2026-08-16 session).
