---
number: 0007
title: A tie on occurredAt breaks on the lexicographically greater eventId, never on arrival order
date: 2026-08-18
status: accepted
---

Sweep item **A-5** in `.artifacts/framing/phase-2-plan-facts.md:574`, the second of round 2.
Round 1's four gaps are `docs/decisions/0005-phase-2-wire-contract-gaps.md`; round 2's first is
`docs/decisions/0006-oversized-event-is-an-event-level-rejection.md`.

**Decided by the coordinator under `/autopilot`, not by the human.** Trigger 3 was tested and did
not fire: a preference is inferable from the approved plan, and the residual freedom is one
comparator inside one pure function. It is recorded here rather than left in a checkpoint because
`p2.merge-rules`, `p2.ingest-endpoint` and every Phase 4 consumer inherit the ordering semantics.
Cheap to overturn — see Detection.

## Context

`MVP_PLAN_V3.md:505-506` — "Completion fields (completedAt, status, output) — last writer wins by
occurredAt, not arrival order." Two completion events carrying an **identical** `occurredAt` are
unspecified for `completedAt` and `output`.

`status` alone is already settled: `MVP_PLAN_V3.md:508-509` and OD-3 give `FAILED` the win over
`COMPLETED` regardless of order. The gap is the other two fields.

Two readings, and the plan does not treat them equally:

- **Arrival order** — the physically last write wins. `MVP_PLAN_V3.md:511-512` rejects exactly
  this shape in the neighbouring rule: "silently picking the later one makes the result depend on
  network timing."
- **A deterministic total order** — the Definition of Done at `MVP_PLAN_V3.md:1608` requires
  conflicting terminal states to resolve "deterministically". A same-`occurredAt` tie is the case
  where that word was not yet defined.

The framing note recorded that "nothing in the plan authorizes" the second reading. That is true
about authorization and beside the point about inference: the first reading is explicitly rejected
and the second is explicitly required, so only one survives.

## Decision

When two completion events for the same `entityId` carry an identical `occurredAt`:

1. `status` resolves by OD-3 — `FAILED` beats `COMPLETED`. Unchanged, and it outranks the rule
   below.
2. `completedAt` and `output` are taken from the event with the **lexicographically greater
   `eventId`**. "Greater" stands in for "last" precisely because there is no honest "last".
3. Arrival order is never consulted, for any field, at any time.

The comparator lives in `p2.merge-rules` under `platform/api/src/**`. It does **not** live in
`platform/shared` — `platform/shared/README.md:25` already excludes it by name.

`eventId` is the right key because it is client-generated and required on every event
(`MVP_PLAN_V3.md:475-480`), so the comparison never depends on a server clock and never depends on
the network.

## Consequences

- The result of a merge is a pure function of the event set, independent of arrival order,
  retries, batch splitting and concurrency. Replaying a batch cannot change an answer.
- The winner is arbitrary in the sense that matters: with UUIDv7 (`MVP_PLAN_V3.md:454`) the greater
  `eventId` is usually but not reliably the later-generated event. This buys determinism, not
  accuracy. Two genuinely simultaneous completions are a client bug, and this rule makes that bug
  reproduce identically rather than intermittently.
- `SeededIdGenerator` (`MVP_PLAN_V3.md:886`) produces identical ids by design across replays, which
  is what makes this rule stable under Phase 3/6 replay rather than a hazard for it.
- Makes harder: any future "prefer the richer payload" or "merge outputs" rule now has to displace
  a stated total order rather than fill a vacuum.

## Detection

- `p2.merge-rules` must ship a test with two completion events sharing one `occurredAt` and
  differing `eventId`, asserted **in both insertion orders** with the same expected winner. If that
  test does not exist, this decision was not implemented — it was assumed.
- The test that would show this decision is _wrong_ rather than merely unimplemented: a real
  workload where the lexicographically greater `eventId` is systematically the staler event. That
  would mean the id generator is not time-ordered and the tie-break key should change. Whoever owns
  `p2.ingest-endpoint` sees it first.
- If a human overturns this, exactly one comparator changes and the two-order test above flips its
  expected value. Nothing persists the choice.
