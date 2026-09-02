---
number: 0014
title: Phase 4's entity ingest seam is built, not deferred; drop counts arrive as a batch field
date: 2026-09-02
status: accepted
---

# 0014 — The Phase 4 entity ingest seam, and how a drop count reaches the platform

- **Status:** accepted
- **Date:** 2026-09-02
- **Deciders:** human (Phase 4 phase-gate escalation), Coordinator (recorded)

## Context

The Phase 4 phase gate ran RED on three of six Definition-of-Done lines and on the DoD
preamble, with all three validation commands green. Full ledger:
`.artifacts/evidence/4/phase-gate/definition-of-done.md`.

Two independent causes.

**One.** All five Phase 4 wire types — `decision.recorded`, `decision.outcome_attested`,
`model_call.recorded`, `tool_call.recorded`, `error.recorded` — are rejected at ingest.
`ENTITY_KIND_BY_EVENT_TYPE` (`platform/api/src/telemetry/event-mapping.ts:52`) maps every one
to `null`; `telemetry.service.ts:356` turns that into an `EVENT_TYPE_NOT_INGESTIBLE`
event-level rejection; `telemetry.service.spec.ts:255` **asserts** the rejection for all five.

The read side is complete: Prisma models `Decision`, `ModelCall`, `ToolCall`, `Error`; six read
methods on `runs.repository.ts`; all eight Run Explorer views. Phase 4 therefore shipped a full
read model over four tables that ingestion can never fill. `platform/api/src/` has no
`model-call`, `tool-call` or `error` module at all, and `DecisionsRepository` has exactly one
method — `attestOutcome` — which nothing calls.

This was declared, never hidden: `decisions.service.ts:21-25` and `app.module.ts:66-73` both
say the write path is unowned, and `DecisionsModule` is registered _deliberately uninjected_ to
leave it buildable "for the node that lands the routing." It was filed twice (`6e221c2`,
wave-4 finding F3). No node ever picked it up, because the seam sits **between** nodes and
`pnpm check:probes` correctly confines each probe to its own node's surface. The probe rule
held; nothing was ever pointed at the boundary.

**Two.** §16's five drop counters (`droppedOverflow`, `droppedInvalid`, `droppedTooLarge`,
`droppedAfterShutdown`, `droppedUndeliverable`) are client-side SDK state.
`TelemetryEventEnvelopeSchema` has no field for them, `IngestRequestSchema` has no batch-level
field, `IngestResponse` runs server→client, and no column stores them. So DoD line 6 cannot be
answered from stored telemetry. Prior analysis and the three options: `BACKLOG.md:3026`.

## Decision

### 1. The full entity ingest write path is built, as one new node

Not decisions-only, and not deferred. `p4.entity-ingest` routes all five types out of the
ingest batch into four entity writers.

Rejected: **decisions only.** It closes DoD lines 4 and 5 exactly and nothing else, leaving the
DoD preamble ("which models and tools were called, where failures occurred") false and three
Run Explorer views rendering permanent absence. Splitting one seam across two nodes also
re-creates the ownership gap that produced this escalation — the second half would again belong
to nobody.

Rejected: **record the gap and advance to 5b.** Phase 5's analysis engine consumes Decisions as
its input. Advancing would build analyzers over a table nothing writes, and the Phase 5 gate
would inherit an unverifiable foundation. That is the failure mode `CLAUDE.md` names: a phase
reported complete at 90% is how the next phase inherits a foundation nobody verified.

This contradicts no accepted decision. **ADR 0005 decision 3 anticipated exactly this**: Phase 2
declared `TelemetryEventType` as Run and Step only, and said new types "arrive with a
`schemaVersion` bump" — which has happened; the five types are legal wire events at
`schemaVersion` '2'. `null` in `event-mapping.ts` is documented there as "no ingest path
**yet**", not as a decision never to build one.

### 2. A drop count reaches the platform as a batch-level field on the ingest request

`IngestRequestSchema` gains an optional `droppedSinceLastBatch`, folded into a per-run counter
column at the persistence edge. `runs.service.ts` `summaryFor` already passes
`droppedTelemetryEventCount` explicitly rather than defaulting it, so the read side is a
one-line change at a grep-able site.

Additive and backwards compatible: an SDK that does not send the field leaves the counter
untouched, and the summary keeps reporting `null` rather than a manufactured `0`.

Rejected: a dedicated **`sdk.health` event type** carrying all five counters as an entity. More
faithful to §16 and it preserves the reason breakdown, but it costs a sixth entity, a new
module and a new table to answer one DoD line. `CLAUDE.md`: prefer the simplest solution
satisfying the current Definition of Done. The breakdown goes to `BACKLOG.md`.

Rejected: **rewriting the DoD line** to match what the Dashboard can show. The card's current
`not reported` is honest and the refusal to print `0` is correct, but amending the plan to fit
the implementation is the wrong direction when the field is cheap.

## Consequences

- `telemetry.service.spec.ts:255` currently **asserts** the rejection of all five types. That
  suite is reversed by `p4.entity-ingest`, deliberately and with the reversal stated in its
  handoff. Reversing a pinned assertion is normally the shape of a green that lies; here the
  pin recorded a temporary state and the ADR is its release.
- `EVENT_TYPE_NOT_INGESTIBLE` stays in `INGEST_ERROR_CODES` and stays exercised — a tenth,
  genuinely unstorable type must still reject per-event rather than fail the batch. The code
  does not become dead.
- Granularity is lost by choice: the platform learns _how many_ events a client dropped, never
  _why_. Anything reasoning about drop causes must still read SDK-side `stats()`.
- Phase 4's gate cannot be re-run until both nodes land. Tester and Reviewer were held back
  from the RED gate on purpose; they run once, over the repaired phase.
- The oracle reported Phase 4 8/8 throughout. Node completion and phase completion are
  different claims, and only the DoD ledger distinguishes them. A probe cannot see a seam its
  node does not own — that limit is by design (`pnpm check:probes`) and this ADR is the cost of
  it being paid once.

## Detection

- 1 is enforced by `entityKindOf` returning non-`null` for all nine types under
  `satisfies Readonly<Record<TelemetryEventType, ...>>` — a tenth type stays a compile error —
  and by integration tests that post each of the five events through the real ingest endpoint
  and read the row back from Postgres. Response-code assertions alone are not enough: the
  regression this replaces (`type.startsWith('run.') ? 'run' : 'step'`) returned ACCEPTED with
  every gate green while writing a Decision id into the Step table. Assert on the store.
- 2 is enforced by a test that posts a batch carrying `droppedSinceLastBatch` and asserts the
  run summary reports the total, plus one that omits the field and asserts the summary still
  reports `null` — never `0`. `run-summary.spec.ts` already pins both halves of that
  distinction and must keep passing.
