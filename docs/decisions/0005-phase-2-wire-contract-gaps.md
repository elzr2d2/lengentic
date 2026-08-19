---
number: 0005
title: Four wire-contract gaps the plan left open at the Phase 2 frontier
date: 2026-08-18
status: accepted
---

Decided 2026-08-18 while framing Phase 2, before any lane was dispatched. Human decision on
all four; each was escalated under `CLAUDE.md` trigger 3, because no preference could be
inferred from the plan, the ODs, or a prior decision.

## Context

`platform/shared/schema/**` is the only wire contract (`CLAUDE.md` `## Types`). Both the SDK
and the API import it, `p2.shared-schema` is wave 1, and `pnpm oracle waves` says "Nothing in
Phase 2 parallelises until this exists". Every other Phase 2 lane is built against whatever it
freezes, so these are one-way decisions and the most expensive place in the phase to be wrong.

All six ODs in `MVP_PLAN_V3.md:2706-2772` are RESOLVED, so the register offered nothing. A
14-item ambiguity sweep over the Phase 2 text found these four schema-shaped and on the
critical path. Full sweep and both readings of each: `.artifacts/framing/phase-2-plan-facts.md`.

## Decisions

### 1. Seen events live in a thin dedup table, not an event ledger

The plan mandates idempotency and a `DUPLICATE` per-event result (§12, OD-2) but §13 defines
**no event entity**. Something must remember what was already ingested.

A table of `eventId`, `runId`, `receivedAt` and nothing else. Enough to answer "have I seen
this?" honestly, and no more.

Rejected: a full ledger storing each event's payload as the source of truth. It is replayable
and better for debugging ingestion, but Phase 2's own objective is "Implement only `Run` and
`Step`" (`MVP_PLAN_V3.md:1558`), no Phase 2 requirement reads a payload back, and
`CLAUDE.md` says prefer the simplest solution satisfying the current Definition of Done.

The cost is accepted and named: raw events cannot be replayed or audited later without a
migration. `MVP_PLAN_V3.md:1560` warns these are "cheap columns now and expensive migrations
in Phase 5" — this is the one place we take that bet deliberately rather than by omission.

### 2. `eventId` is unique per run, not globally

Unique on `(runId, eventId)`.

Rejected: `eventId` as a global primary key. It is the simpler mental model, and it is a trap.
`MVP_PLAN_V3.md:886`'s `SeededIdGenerator` produces **identical ids by design**, because that
is what makes Phase 3 and Phase 6 deterministic. Under a global key, replaying the same seeded
scenario a second time ingests nothing and reports `DUPLICATE` for a genuinely new run — a
Phase 3 failure manufactured by a Phase 2 index, discovered two phases from its cause.

The composite costs nothing today. That asymmetry is the whole argument.

### 3. `TelemetryEventType` is `Run` and `Step` only

Four values: run started, run completed, step started, step completed. Any other type is
rejected as unknown, with the rejection surfacing as that event's own per-event result.

`MVP_PLAN_V3.md:475` references `TelemetryEventType` exactly once and never enumerates it
anywhere in the document.

Rejected: declaring `decision`, `modelCall`, `toolCall` and `error` now so the contract does
not churn when Phase 4 arrives. Phase 2 has no table for any of them, so the contract would
accept events it must then silently drop. This project's recurring failure is the green that
lies; accepting data with nowhere to put it is exactly that shape. New types arrive with a
`schemaVersion` bump.

### 4. `STALE` replaces `RUNNING` in the API response

Stored `status` stays `RUNNING` forever — `MVP_PLAN_V3.md:592` is explicit that `STALE` is
"Derived, not stored", and it is absent from the `status` enum at `:583`. A killed script
leaves `RUNNING` in the database and nothing ever writes `STALE`.

The **response** type is a view model, not the row. It reports `STALE`, computed server-side
against the server clock, from `lastEventAt` and `STALE_RUN_THRESHOLD_MS` — which already
exists in `platform/api/src/config/env.schema.ts` and must be consumed, not reintroduced.

Rejected: `status: RUNNING` plus a separate `isStale: true`. It is more honest about which
value came from where, but it obliges every consumer to check two fields, and one that checks
only the first displays a dead run as live.

Server-side is load-bearing. Deriving `STALE` in the Dashboard would put the **browser** clock
in charge of deciding whether a run is alive, and `MVP_PLAN_V3.md:493` already forbids the
related sin: "Never combine client and server clocks in one duration calculation." The server
clock is authoritative for exactly one thing in this system — liveness — and this is it.

## Detection

A decision nobody can catch being violated is a decision that will be violated.

- 1 and 2 are enforced by the migration and its unique index; `p2.integration-tests` owns
  "posting the same event batch twice produces no duplicates" (`MVP_PLAN_V3.md:1605`).
  **That checkbox alone is not enough** — sweep item A-7 shows it goes green on two different
  implementations, one of which leaves the `duplicate` counter permanently dead. The test must
  assert the per-event `DUPLICATE` results, not only the row counts.
- 3 is enforced by the Zod union in `platform/shared/schema/**` rejecting an unknown type, and
  by a negative fixture asserting the rejection is per-event and does not fail the batch
  (`MVP_PLAN_V3.md:1611`, "A malformed event in a batch rejects only itself").
- 4 is enforced by a test that advances a clock past the threshold and asserts the response
  flips to `STALE` while the stored row still reads `RUNNING`. If the stored row can ever read
  `STALE`, the derivation has leaked into persistence.

## Still open

Round 2 of the frontier is listed in `.claude/autopilot.local.md`. The two that most affect this
contract have since been answered and are no longer open:

- **A-3** — the 32 KB-per-field client cap (§15) and the 64 KB-per-event server cap (OD-2) do not
  compose; three client-legal fields make an illegal event. Answered by the human 2026-08-18 in
  `docs/decisions/0006-oversized-event-is-an-event-level-rejection.md`.
- **A-5** — the tie-break when two completion events share an `occurredAt`, where OD-3 settles
  `status` but leaves `completedAt` and `output` undefined while the Definition of Done demands the
  resolution be "deterministic". Answered by the coordinator 2026-08-18 in
  `docs/decisions/0007-equal-occurredat-ties-break-on-eventid.md`.

A-6 through A-13 were closed 2026-08-19 in
`docs/decisions/0008-phase-2-ambiguity-sweep-a6-a13-closed.md`. Nothing from the sweep
remains open; Phase 2 framing may not reopen a sweep item without superseding 0008.
