---
number: 0001
title: Keep nine agents, not the four the plan specifies
date: 2026-08-16
status: accepted
---

Backfilled 2026-08-16 from `BACKLOG.md:152`, where this decision was recorded before
`docs/decisions/` existed. Rationale below is quoted, not reconstructed.

## Context

`MVP_PLAN.md` §18 and `MVP_PLAN_V3.md` §9 specify a roster of four — Architect, Builder,
Validator, Reviewer — with Diagnostician and Reflector created **only when a real failure
demands them**. §21 goes further and merges v1's Runner and Tester into Validator,
"because the handoff cost exceeded the separation benefit."

Five agents beyond that roster — `runner`, `tester`, `watchdog`, `diagnostician`,
`reflector` — were already present in `.claude/agents/` as imports from another project.

The choice was: delete the five unsanctioned agents and return to the plan's four, or
keep all nine and justify each.

## Decision

Keep all nine. Rewrite the five to this repository with non-overlapping scopes
(`BACKLOG.md:166-173`):

```text
runner        execute, report raw evidence, interpret nothing
validator     per-packet / per-wave behavioural validation   (the hot path)
tester        per-phase adversarial falsification, fresh session
watchdog      judgement layer over `pnpm check:integrity` + diff scope
diagnostician escalation from a BLOCKED handoff with unclear cause
reflector     cross-milestone process and cost retrospective
```

Non-overlap is not left to prose. `.claude/rules/agent-activation.json` declares a
disjoint `responsibilities` block per agent and maps change classes to capabilities, so
the roster is enforced by what `pnpm oracle packet` routes rather than by an agent's own
judgement.

`handoff.schema.json`'s `owner` enum gained `diagnostician` and `human`. The
reporting-only roles are never an owner, "so the enum did not grow to nine."

## Consequences

Quoted from `BACKLOG.md:175`:

> The cost this carries is standing context load and a real risk that two roles get
> invoked "to be safe".

Mitigations already in place: `.claude/rules/agent-activation.json` states that "Agents
are conditional tools, not a mandatory pipeline", and `CLAUDE.md:112` forbids running
Architect, Validator and Reviewer after every minor edit.

A second cost, recorded elsewhere: `.artifacts/plans/phases-2-7-execution-plan.md` §7
flags that "Tester on `opus` fires on every behavior-class wave — Phases 3, 5, 6 and 7
are almost all behavior class. That is the largest uncontrolled cost in the schedule."

## Detection

Assigned to `reflector`, quoted from `BACKLOG.md:176`:

> if a milestone shows `runner`, `tester`, or `watchdog` invocations whose output never
> changed a decision, the §21 merge was right and they should collapse back into
> `validator`.

That is the falsification condition. It has an owner, a trigger point (milestone
boundary), and a named consequence. Until a milestone produces that evidence, the roster
stands.

Secondary test, from the research note
`docs/research/2026-08-16-matt-pocock-ai-engineering.md` §15 — a role earns existence only
if it changes permissions, context inputs, model/tool choice, output schema, verification
authority, or lifecycle. Note that section is LenGentic-derived and is a restatement of
this repository's own reasoning, not outside corroboration.
