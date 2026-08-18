---
number: 0006
title: A single event over 64 KB is an event-level rejection, and the SDK caps whole events too
date: 2026-08-18
status: accepted
---

Decided 2026-08-18 while finishing round 2 of the Phase 2 framing frontier, before the wire
contract was frozen. Human decision, escalated under `CLAUDE.md` trigger 6 — two approved
requirements genuinely conflict and honouring one as written breaks the other.

Sweep item **A-3** in `.artifacts/framing/phase-2-plan-facts.md`. Round 1's four gaps are
`docs/decisions/0005-phase-2-wire-contract-gaps.md`; this is round 2's first.

## Context

Two limits in the approved plan do not compose:

- `MVP_PLAN_V3.md:793` (§15, client) — "Size cap Default 32KB **per field**."
- `MVP_PLAN_V3.md:529` (OD-2, server) — "Max single event payload 64 KB **after client-side
  capping**."

An event carrying three fields, each capped legally at 32 KB, is 96 KB. The SDK produces it
without violating its own rule; the server must refuse it under its own. Neither document
notices.

Worse, the 64 KB cap has no enforcement point at all. `MVP_PLAN_V3.md:531-534` lists the
request-level rejections (body size, invalid JSON, batch count) and `MVP_PLAN_V3.md:536-540`
lists the event-level ones (schemaVersion, unknown type, missing fields, Zod failure). **An
oversized single event appears in neither list.**

## Decision

**The server rejects an over-64 KB event at the event level, and the SDK caps the whole
serialized event, not only each field.**

Concretely:

1. `platform/shared/schema/**` gains a rejection reason for an oversized event, exported as a
   named constant beside the other §12 rejection reasons. It is **event-level**: the offending
   event is `REJECTED`, the other 499 in the batch are still processed. This follows
   `MVP_PLAN_V3.md:543-544` — "A malformed event never rejects the whole batch. One bad event
   in a 500-event flush must not discard 499 good ones."
2. The measurement is on the serialized event, and the limit constant is the one already
   declared for it. There is one number, in one place, read by both sides.
3. The SDK's capping pipeline (`MVP_PLAN_V3.md:788` — "safe serialization → redaction → size
   cap / truncation") measures the whole event after per-field capping. If the event still
   exceeds the limit, the SDK truncates further and sets the `*Truncated` flag rather than
   sending something it knows the server will refuse.

The pairing is the decision. Point 1 alone leaves the SDK generating events it knows are
illegal; point 3 alone leaves the limit unenforced and trusting a client.

## Rejected alternative

**64 KB is client-side advice; the server enforces only the 5 MB body.** Defensible on the
literal words "after client-side capping", which can be read as "the client has already
guaranteed this". Simpler server, no new rejection code.

Rejected because it makes the stated limit not a limit. A 500-event batch of 60 KB events is
30 MB and is caught only by the body cap; a single 4 MB event is accepted and stored, which
is the exact outcome `MVP_PLAN_V3.md:794` forbids in the client's own words — "Never silently
store a 4MB blob." A limit that trusts the caller to enforce it is not enforced, and the
caller here is a public SDK that any consumer can fork or bypass.

## Consequences

- The wire contract carries one rejection reason the plan never listed. `schemaVersion` stays
  `'1'`; adding a rejection reason narrows what is accepted, so it must land **now**, with the
  first contract, and not in a later phase. This is the one-way half of the decision.
- `p2.shared-schema` owns the constant and the reason. `p2.ingest-endpoint` owns the check.
  `p2.sdk-core` owns the whole-event cap. All three cite this ADR.
- Accepted cost: an event whose fields are each individually legal can still be truncated by
  the SDK a second time. A caller who sends three large fields loses more content than the
  per-field rule alone implies. This is visible — the `*Truncated` flag is set — not silent.

## Detection — how this goes green while being wrong

A test that posts one 100 KB event and asserts HTTP 400 passes under a **request-level**
implementation, which would discard the other 499 good events in the batch. The test must post
a batch containing one oversized event **and** several valid ones, then assert the valid ones
are `ACCEPTED` and only the oversized one is `REJECTED` with this reason. Row counts alone
cannot tell the two implementations apart — the same defect class as A-7 in
`docs/decisions/0005-phase-2-wire-contract-gaps.md`.
