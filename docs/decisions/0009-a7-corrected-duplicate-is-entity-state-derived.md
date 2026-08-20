---
number: 0009
title: A-7 corrected — `duplicate` is entity-state-derived and incomplete until the ADR 0005 §1 ledger exists; the ledger is p2.idempotency's
date: 2026-08-20
status: accepted
---

Supersedes `docs/decisions/0008` **§A-7 only**. Every other item in 0008 (A-6, A-8 through
A-13) stands unchanged and is not reopened by this record.

Human decision 2026-08-20, under `CLAUDE.md` escalation trigger 3, on the ruling the
`p2.ingest-endpoint` Tester returned. The alternative — widening `p2.ingest-endpoint` to
reach `schema.prisma` — was put and rejected in the same decision.

## Context

A-7 asserted, as settled contract: "A replayed batch returns `accepted: 0, duplicate: N`
with per-event `DUPLICATE` results." A fresh independent Tester falsified it against a live
Postgres on 2026-08-20 (`.artifacts/evidence/2/tester-reverify/raw/f3.out`):

```text
D2.1  post a 4-event batch          -> accepted 4, duplicate 0
D2.2  post the SAME batch again     -> accepted 2, duplicate 2
        sA=DUPLICATE  sB=ACCEPTED  cA=DUPLICATE  cB=ACCEPTED
D2.3  post the SAME batch a third   -> accepted 2, duplicate 2   (stable, not converging)
```

The cause is not a defect in `p2.ingest-endpoint`'s implementation of A-7. It is that the
thing A-7 assumes exists does not. `0005` §1 decided "seen events live in a thin dedup
table"; no such table was ever built — `platform/database/prisma/schema.prisma` holds
`model Run` and `model Step` and nothing else. `p2.prisma-run-step`'s packet said
"Implement only `Run` and `Step`", so it correctly did not add one, and `p2.idempotency`'s
`allowed_paths` were `platform/api/src/**`, so it could not. `BACKLOG.md:1314` recorded that
orphan in advance — "ADR 0005's dedup table has no lane that can write it… Decide before
that packet is dispatched."

Lacking a ledger, `collectKnownEventIds`
(`platform/api/src/telemetry/telemetry.service.ts:61-93`) reconstructs "have I seen this
`eventId`?" from the entity row's own provenance columns — `startEventId`,
`completionEventId`, `completionFieldOrigins`. Those columns record **winners**. An event
that wins no contest — a start event that loses first-writer-wins, a completion event that
wins neither `completionEventId` nor any field origin — leaves no trace on the row, and is
therefore re-classified `ACCEPTED` on every subsequent post, forever.

`0005`'s own Detection block predicted this exact shape: the row-count checkbox "goes green
on two different implementations, one of which leaves the `duplicate` counter permanently
dead." It is half-dead rather than dead, which is why it survived to the Tester.

## Decision

**A-7 is corrected, not deleted. Three parts.**

1. **The contract claim stands.** `MVP_PLAN_V3.md` §12 "Re-posting a known eventId is a
   no-op", and A-7's `accepted: 0, duplicate: N` on a replayed batch, remain the required
   behaviour. They are not weakened to match the implementation. What changes is their
   status: A-7 was recorded as _already satisfied by shipped code_, and it is not — it is
   an open requirement with a named owner.

2. **Entity-state-derived dedup is a documented interim, not the design.** Until the ledger
   exists, `duplicate` is exact only for events that won something. This is now stated in
   the code it describes and in this record, so no later reader can cite A-7 as evidence
   that replay is closed.

3. **The ledger is `p2.idempotency`'s deliverable, and `p2.idempotency` owns the schema.**
   Its `allowed_paths` in `scripts/oracle/graph.json` are widened from `platform/api/src/**`
   to add `platform/database/prisma/**` and `platform/database/src/**`. It implements
   `0005` §1 as written — `eventId`, `runId`, `receivedAt`, unique on `(runId, eventId)` per
   `0005` §2 — under the model name `IngestedEvent`.

**Rejected: widening `p2.ingest-endpoint` to reach `schema.prisma`.** It is the shorter
path and it is the wrong one. That lane is mid-repair on a false green; letting a lane
under repair also write a migration on a shared write surface is how the repair acquires a
second, unreviewed failure mode. `CLAUDE.md` is flat about it — "Widening its own boundary
is never the answer" — and the boundary held here exactly as designed: the lane reported
`BLOCKED` naming the path instead of reaching for it.

**Rejected: weakening §12 to "re-posting a winning eventId is a no-op".** It would make
every current test green and would silently redefine idempotency as a property of merge
outcomes rather than of event identity. An SDK retry after a timeout re-posts whatever it
buffered, winners and losers alike; a contract that only covers winners does not cover the
case it exists for (`MVP_PLAN_V3.md:845`, A-10's "a timeout resend is safe").

## Consequences

- `p2.idempotency` becomes a schema-writing node: `risk: high`, and
  `platform/database/prisma/schema.prisma` is already in `lanePolicy.sharedWriteSurfaces`.
  Both force it to run alone. It cannot be batched with another lane, and it costs a
  migration on a surface `p4.entities` also writes later.
- Phase 2 cannot reach `ADVANCE_PHASE` until the ledger exists. `p2.idempotency`'s
  `model IngestedEvent` probe fails until then, so the node is never `DONE`, so the wave-2
  gate never records, so `pnpm flow next` never reaches `PHASE_GATE`. That is the intended
  block, not a side effect.
- `0008` remains the authority for A-6 and A-8..A-13. Its `status` line now points here for
  A-7. A reader who loads `0008` alone and acts on A-7 is reading a superseded claim — the
  pointer in its front matter and the note at §A-7 are what prevent that.
- The `0005` §1 cost accepted then is now partly paid: the ledger arrives in Phase 2 rather
  than never. What is still deferred is the _payload_ ledger — raw events remain
  unreplayable without a Phase 5 migration, unchanged by this record.
- `p2.ingest-endpoint` keeps its interim derivation. It is fail-safe (a repost cannot create
  a second row or error, because `merge-rules.ts` is pure and entities upsert by
  `entityId`), which is the only reason shipping it ahead of the ledger is tolerable.

## Detection

- **A-7 itself:** `p2.integration-tests` posts a batch containing at least one event that
  loses its merge contest, then re-posts the identical batch, and asserts
  `accepted: 0, duplicate: N` with per-event `DUPLICATE` on **every** event. The 2026-08-20
  `f3.out` D2.2 sequence is the ready-made negative fixture — it must flip from
  `accepted:2, duplicate:2` to `accepted:0, duplicate:4`. A test that replays only winners
  is the same green that lies A-7 was written to prevent, and is not evidence for this
  record.
- **The ledger's existence:** `p2.idempotency`'s `model IngestedEvent` probe in
  `scripts/oracle/graph.json`. If it is ever satisfied by a model that is not the ADR 0005
  §1 shape, `pnpm check:probes` will not catch it — a reviewer must read the migration.
- **The interim, if it outlives Phase 2:** any handoff or document that cites A-7 without
  citing this record is reading `0008` alone. `pnpm kb search A-7` returns both.
- **Ownership:** `pnpm lanes check p2.idempotency` fails if the ledger migration is written
  from any other lane; `pnpm oracle packet p2.idempotency` is where the widened surface is
  visible to the agent that gets the work.
