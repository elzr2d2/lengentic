---
number: 0008
title: Ambiguity sweep items A-6 through A-13 are closed; Phase 2 framing may not reopen them
date: 2026-08-19
status: accepted; §A-7 superseded by 0009
---

Closes the remainder of the 14-item ambiguity sweep from Phase 2 framing
(`.artifacts/framing/phase-2-plan-facts.md` §6). A-1 to A-4 were settled by
`docs/decisions/0005` and `0006`; A-5 by `0007`; A-14 by `0005` §2. A-6 to A-13 stood
"unasked" while three of the four Phase 2 wave-1 lanes shipped code that settles most of
them. Human directive 2026-08-19: resolve or archive all eight so framing cannot reopen
them by accident. Where shipped contract text already decides an item, this record quotes
it; where a choice was still open (A-10 retry policy, A-11, A-12), the coordinator decided
by inference from the plan and `CLAUDE.md` ("prefer the simplest solution satisfying the
current Definition of Done"), under that directive.

## Context

`p2.shared-schema`, `p2.prisma-run-step` and `p2.merge-rules` are DONE on `main`.
`p2.ingest-endpoint` is implemented on its lane branch. The SDK lanes (`p2.sdk-core`,
`p2.sdk-injection`) are not started, and A-10/A-11/A-12/A-13 are the items that shape them.
An item left "open" that a shipped contract has already decided is a re-litigation trap:
the next framing round would surface it as undecided and stall a wave on a question with
one legal answer.

## Decision

### A-6 — `occurredAt` format: ISO-8601 datetime string with required offset

Decided by the shipped contract: `platform/shared/schema/primitives.ts:8` —
`TimestampSchema = z.iso.datetime({ offset: true })`. Any event whose `occurredAt` does not
parse as an offset-carrying ISO datetime is event-level `REJECTED`. The consequence the
sweep flagged — a `SeededClock` making equal-`occurredAt` ties the normal case — is already
absorbed by `0007` (ties break on `eventId`).

### A-7 — the `duplicate` counter is real, never dead code

> **SUPERSEDED by `docs/decisions/0009` (2026-08-20).** The last sentence below —
> "`p2.ingest-endpoint` implements it" — was falsified against live Postgres: a replayed
> 4-event batch returns `accepted: 2, duplicate: 2`, stably. The requirement stands; the
> claim that shipped code satisfies it does not. Read `0009` before citing this item.

Reading 1. A replayed batch returns `accepted: 0, duplicate: N` with per-event `DUPLICATE`
results. `0005` Detection already requires the test to "assert the per-event `DUPLICATE`
results, not only the row counts"; `p2.ingest-endpoint` implements it. Row-count-only
assertions are the checkbox that goes green on the wrong implementation — forbidden.

### A-8 — `schemaVersion`: literal in the schema, named rejection on the wire

Both halves shipped, so both readings were partly right.
`platform/shared/schema/envelope.ts:10` pins `z.literal('1')`;
`platform/shared/schema/parse.ts:51-54` orders validation so any other value yields the
specific `UNSUPPORTED_SCHEMA_VERSION` code (`ingest.ts:8`), not a generic Zod error. A
future `'2'` is a schema change plus a parse-order change, never a route change.

### A-9 — `batchId` is server-generated, per request, never stored

Follows from `0005` §1: the thin dedup table has no batch column, and no event ledger
exists to hang one on. `batchId` is a correlation id in the response and in logs. If A-1
is ever reopened toward an event ledger, storage of `batchId` reopens with it — and only
then.

### A-10 — HTTP 200 for every processed batch; the SDK retries transport and 5xx only

Reading 1. The lane's controller declares `@HttpCode(HttpStatus.OK)`: a processed batch is
`200` with the `IngestResponse` body, whatever `rejected` counts it carries. "207-style"
describes the body shape only. Request-level failures are `400` with `REQUEST_ERROR_CODES`.

SDK retry classifier, binding `p2.sdk-core`: retry transport failures and `5xx`, with the
bounded budget of §16. Never retry a `400` — it is deterministic, and retrying it burns a
finite budget on a batch that cannot succeed. Never re-post individual `REJECTED` events —
rejection is deterministic too. A timeout resend is safe because `eventId` is assigned at
enqueue time, which is the only reading under which §16's "Retrying … exercises the
idempotency contract" is true (`MVP_PLAN_V3.md:845`).

### A-11 — the SDK surface uses `workflowName` and `agentName`

Reading 1. The public SDK signature matches the wire contract and the §13 columns
(`workflowName`, `agentName`) exactly. The §16 example's `workflow`/`agent` is
illustrative. Rejected: ergonomic aliases — a mapping layer inside the one public
artifact, bought with breaking-change risk in Phase 3 and paid for with nothing.

### A-12 — Phase 2 ships the safe-serializer and cap seams; Phase 4 ships redaction defaults

Reading 1. `MVP_PLAN_V3.md:848` binds the Phase 2 SDK: record methods "must not throw
because of circular data, redaction failure, serialization failure, transport failure, or
buffer overflow" — impossible with a naive `JSON.stringify` path. So Phase 2 lands the
§15 ordered pipeline seams (safe serialization → cap → enqueue) with tests; Phase 4 adds
redaction defaults and the `*Truncated` flags. The testing-ownership table
(`MVP_PLAN_V3.md:1330`) is read as who _hardens_, not who first tests — the same document
forbids introducing the first meaningful tests late (`:1335-1336`).

### A-13 — §17 injection seams land in Phase 2; ratified

The harness already schedules `p2.sdk-injection` in Phase 2
(`scripts/oracle/graph.json:609-630`) against `MVP_PLAN_V3.md:1726`'s Phase 3 row. This
record is the explicit note the gate required: the divergence is deliberate. Phase 3
supplies the seeded implementations; it does not reopen the SDK package.

## Consequences

`p2.sdk-core` and `p2.sdk-injection` build against A-10/A-11/A-12/A-13 without a framing
round. Reopening any item now requires superseding this record — a deliberate act with a
new number, not an accident of a fresh session's sweep. The A-12 split leaves redaction
genuinely absent until Phase 4; a payload with secrets recorded in Phase 2/3 development
is stored unredacted, which is acceptable only because both phases run against local dev
databases.

## Detection

- A-6/A-8: contract tests on `platform/shared/schema` fail on any format or literal drift.
- A-7: the idempotency test asserts per-event `DUPLICATE` statuses; an implementation that
  re-accepts a replay turns it red. **It did — see `0009` Detection, which replaces this
  line with the losing-event replay fixture.**
- A-10: an SDK test must show a `400` is not retried and a transport failure is, within the
  finite budget. If `p2.sdk-core` ships without that test, its handoff cannot verify §16's
  Retrying criterion.
- A-11: the Phase 3 Playground compiles against the public entry; a rename breaks it loudly.
- A-12: a Phase 2 SDK test records a circular payload without throwing; absence of that
  test leaves `MVP_PLAN_V3.md:848` unbound and is a RED at the phase gate.
- A-13: `p2.sdk-injection`'s own acceptance criteria, then Phase 3's byte-identical check.
