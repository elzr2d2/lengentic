# Decision records

A decision that is **settled, costly to reverse, and blocks nothing.**

That is the whole niche. It is narrow on purpose. This repository already had three homes
for decisions before this folder existed, and a fourth home is only worth its navigation
cost if it takes what none of the other three will hold.

## The admission rule

Three exclusion tests. A note qualifies only when **all three fail**.

```text
Does it block a deliverable?          -> not an ADR.  It is an openDecisions node
                                         (OD-*) in scripts/oracle/graph.json, where
                                         the oracle can refuse to dispatch on it.

Is it a thing we might do later?      -> not an ADR.  It is a BACKLOG.md entry, with
                                         its Source and, if deferred on data, the
                                         amount of data that reopens it.

Is it what a word means here?         -> not an ADR.  It is a CONTEXT.md term.

Is it a contract code must satisfy?   -> not an ADR.  It is an MVP_PLAN_V3.md section.
```

Left over: the choice that is made, expensive to unmake, explains a shape a reader would
otherwise find surprising, and is not gating any work. That is an ADR.

If you are unsure, it is not one. The failure mode this folder invites is recording
routine choices as architecture, and that failure is silent — it looks like diligence
until the directory is thirty files deep and nobody reads any of them.

## Why the folder exists at all

`BACKLOG.md:152` — "Nine-agent roster — deliberate deviation from §18 / v3 §9". Source:
"human decision, 2026-08-16". It records what was chosen, why, what it costs, and the
mechanism that will detect if it was wrong.

None of that is a deferred idea. It was an ADR filed in a ledger of ideas, because the
ledger was the only place that would take it. That is the gap this folder closes, and it
is the size of the gap: small.

## Format

```text
---
number:   NNNN
title:    <the decision, as a statement>
date:     YYYY-MM-DD
status:   accepted | superseded by NNNN
---

## Context      what was true that forced a choice
## Decision     what was chosen, stated flatly
## Consequences what this costs, including what it makes harder
## Detection    what would show this was wrong, and who would see it
```

`Detection` is not standard ADR practice and is required here. A decision with no way to
find out it was wrong is a belief. It matches how `BACKLOG.md` requires a deferred-on-data
item to name how much data.

## Rules

- **Never edited after acceptance.** A decision that changes gets a new record, and the
  old one gains `status: superseded by NNNN`. The reasoning that produced a wrong
  decision is worth keeping — the same rule as `BACKLOG.md`'s never-delete.
- **Numbered, in order.** `0001-`, `0002-`. The number never changes.
- **Backfills quote, they do not invent.** A record written after the fact cites the text
  that already existed. If no such text exists, the decision was not actually made, and
  writing an ADR would be manufacturing a rationale.
- **Not loaded by default.** Like research notes, an ADR enters a session because
  something pointed at it.

## Index

| #                                                           | Decision                                                | Date       | Status   |
| ----------------------------------------------------------- | ------------------------------------------------------- | ---------- | -------- |
| [0001](0001-nine-agent-roster.md)                           | Nine agents, not the plan's four                        | 2026-08-16 | accepted |
| [0002](0002-sequential-is-the-default.md)                   | Sequential default; unknown counts as false             | 2026-08-16 | accepted |
| [0003](0003-contextkey-is-caller-computed.md)               | The caller computes `contextKey`                        | 2026-08-16 | accepted |
| [0004](0004-no-tester-at-the-5a-gate.md)                    | No Tester at the 5a gate; a spec instead                | 2026-08-16 | accepted |
| [0005](0005-phase-2-wire-contract-gaps.md)                  | Four wire-contract gaps at the P2 frontier              | 2026-08-18 | accepted |
| [0006](0006-oversized-event-is-an-event-level-rejection.md) | Oversized event rejects event-level, not the batch      | 2026-08-18 | accepted |
| [0007](0007-equal-occurredat-ties-break-on-eventid.md)      | Equal-`occurredAt` ties break on `eventId`              | 2026-08-18 | accepted |
| [0008](0008-phase-2-ambiguity-sweep-a6-a13-closed.md)       | Sweep items A-6..A-13 closed; not reopenable in framing | 2026-08-19 | accepted |
