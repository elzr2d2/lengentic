---
number: 0010
title: An infrastructure failure is not an event-level rejection — 503/500 on the request, never `REJECTED` on the event
date: 2026-08-20
status: accepted
---

Human decision 2026-08-20, under `CLAUDE.md` escalation trigger 3, on the ruling the
`p2.ingest-endpoint` attempt-2 Tester returned. The alternative — admitting
`PROCESSING_FAILED` into `platform/shared/schema/**` as a real event-level code — was put by
name and rejected in the same decision.

Neighbour to `docs/decisions/0006`, which decided the mirror-image case: an oversized event
_is_ an event-level rejection, because size is a property of the event. This record is the
same test applied to a failure that is not.

## Context

`p2.ingest-endpoint` repair attempt 2 (`80a3f2c`) closed the concurrent-write race and the
arrival-order defect, both of which survived adversarial attack. It closed the third finding
— "a throw in group N must not leave groups 1..N-1 committed behind a bare 500" — by wrapping
each entity group in a `try`/`catch` and classifying whatever it caught as a per-event
`REJECTED` carrying a new code, `PROCESSING_FAILED`.

The code was invented in the service. A fresh Tester drove the contract directly
(`.artifacts/evidence/2/tester-reverify-attempt-2/raw/wire-contract.txt`):

```text
PROCESSING_FAILED in wire contract?              -> false
member of EVENT_LEVEL_ERROR_CODES?               -> false
response still parses?                           -> true   (code is z.string())
occurrences: telemetry.service.ts:126, 240, 251
```

`platform/shared/schema/ingest.ts:30-36` says of that list: "Derived from
`INGEST_ERROR_CODES` itself, so this list cannot drift from the codes it classifies." It had
drifted. The permissive `z.string()` is why nothing failed — the contract admitted a code it
does not define, so the drift was invisible to every mechanical check.

Three reproduced wire defects followed from the classification, not from the code's name:

```text
T2  1 year-0000 event + 99 well-formed siblings, same entity group
    -> 200 {accepted:0, duplicate:0, rejected:100}; row = null
    -> 99 valid events permanently lost
    -> contradicts MVP_PLAN_V3.md:1611 verbatim: "A malformed event in a batch rejects only
       itself", and :543-544 "One bad event in a 500-event flush must not discard 499 good ones"

T3  repost of a committed start + a bad sibling
    -> both REJECTED/PROCESSING_FAILED, message "could not persist run d2xb-run"
    -> read-back: the row EXISTS, status RUNNING, startEventId d2xb-run-start
    -> asserts non-persistence of persisted data; downgrades a contractual success
       (MVP_PLAN_V3.md:562 "DUPLICATE is a success, not an error")

T4  `Run` table renamed away mid-flight (total persistence outage)
    -> 200, counts {accepted:0, duplicate:0, rejected:3}, all REJECTED
    -> every event lost and reported terminally, so no client will retry
    -> GET /health returns 200 {"database":"up"} throughout — two interfaces disagreeing
```

`MVP_PLAN_V3.md:531-541` enumerates three request-level rejection reasons and four
event-level ones (plus `EVENT_TOO_LARGE` per `0006`). Every one is a property of the event or
of the request. An infrastructure failure is in neither list.

## Decision

**`REJECTED` means the event itself is invalid. An infrastructure failure says nothing about
event validity, so it may never be reported as one.**

Four cases, exhaustive:

| Condition                                          | Response                             |
| -------------------------------------------------- | ------------------------------------ |
| Invalid or malformed **event**                     | existing event-level `REJECTED` code |
| Invalid **request**                                | existing request-level HTTP 400      |
| Known infrastructure/dependency unavailable (DB)   | HTTP 503                             |
| Unexpected server-side persistence/processing fail | HTTP 500                             |

**`PROCESSING_FAILED` is not added to `platform/shared/schema/**`.** It is removed from the
service. No new wire error code is introduced by this repair.

**Retry safety is not this endpoint's problem to re-solve.** It already belongs to
dedup/idempotency, so a 5xx and a client retry is the correct recovery path — which is
precisely why a terminal per-event `REJECTED` is the wrong one: it tells the client the data
is unsalvageable when it is merely unwritten.

**No 5xx response body may carry internal detail** — no stack, no filesystem path, no SQL or
internal error code, no compiled source, no raw exception text. Full evidence is preserved in
logs and artifacts only. The leak was reproduced (T1): the wire carried
`…\platform\api\dist\telemetry\telemetry.repository.js:157:22`, four lines of compiled
source, and SQLSTATE `22008`; the lock-contention variant additionally echoed the
`pg_advisory_xact_lock` SQL.

**Rejected: admitting `PROCESSING_FAILED` to the wire contract as a retryable event-level
code.** It is the smaller diff and it buys the wrong thing. It would redefine `REJECTED` from
"the event is invalid" to "the event is invalid, or the server had a bad day", and every
consumer would then need out-of-band knowledge of which codes are terminal to know whether
its data still exists. `0006` admitted `EVENT_TOO_LARGE` to that list because size is a fact
about the event that no retry changes; a dropped database connection is the opposite kind of
fact. Adding it would also require an ADR to change approved wire contract mid-repair, on a
lane already under repair for a false green.

## Consequences

- T2, T3 and T4 are one defect with one fix. None of them can be closed independently, because
  each is a consequence of the same misclassification — which is why the repair was held for
  this decision instead of being attempted piecemeal.
- The endpoint gets stricter about what it promises: a caller that receives 200 now knows every
  event in the batch got a real per-event verdict. That is the property T4 destroyed, and it is
  the only reason per-event results are worth returning at all.
- A batch that hits a dependency outage returns 503 and is retried whole. Duplicate work on
  retry is bounded by dedup, exactly as `0009` §3 requires — and is the reason the interim
  entity-state-derived dedup being incomplete (F3) is tolerable but not free.
- `EVENT_LEVEL_ERROR_CODES` regains the property its comment claims. Note the claim was never
  mechanically true: `code` is `z.string()`, so nothing prevents the next drift either. Filed
  to `BACKLOG.md` rather than fixed here — tightening it to an enum is a wire-contract change
  and belongs to whoever owns `platform/shared/schema/**`, not to this repair.
- `REQUEST_ERROR_CODES` (`BODY_TOO_LARGE` / `INVALID_JSON` / `INVALID_BATCH`) is still never
  emitted — dead code, pre-existing, predicted at `BACKLOG.md:1259` and re-confirmed by this
  Tester. Out of scope here; unchanged by this record.
- F3 is untouched. It remains `DEFERRED → p2.idempotency`, `UNVERIFIED`, per `0009`. Nothing in
  this record may be read as evidence that replay is closed.

## Detection

- **The code's absence:** `grep -r PROCESSING_FAILED platform/` returns nothing. If it returns
  a hit in `platform/shared/schema/**`, this record was reversed without being superseded.
- **T4, the one that reads as success:** rename the `Run` table away, post a batch, assert the
  response is 503 and **not** 2xx. A test that only asserts "not 200" passes on a 500 too, and
  a test that mocks the repository does not exercise the boundary that failed — it must be the
  real database, through the real HTTP boundary. `raw/d2-outage.txt` is the ready-made fixture.
- **T2, the one that hides behind a green batch:** post 1 malformed event + 99 valid ones in a
  single entity group and assert 99 rows persist. The batch-level counts alone cannot catch
  this; the assertion must be a database read-back.
- **T3, the one the response lies about:** never trust the response for a persistence claim.
  Assert `REJECTED` implies the row is absent, by read-back.
- **T1, the leak:** assert the 5xx body matches no filesystem path, no `at …:\d+:\d+` frame,
  and no five-digit SQLSTATE. A snapshot test of a happy-path error body will not catch this —
  the leak only appears on the paths that throw.
- **T5, containment:** the recursion that overflows is `containsUnsafeUnicode`
  (`wire-sanitize.ts:52-66`), called at `telemetry.service.ts:171` **outside** the `try`. Depth
  is not a stable threshold (7000 escaped as a single event; 8000 was contained in a batch;
  ≥9000 escaped on every attempt), so a test pinned to one depth proves little. Assert the
  boundary instead: no input shape produces a 500 with zero per-event results.
