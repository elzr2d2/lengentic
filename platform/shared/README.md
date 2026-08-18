# @lengentic/shared

The wire contract. `platform/shared/schema/**` is the **only** wire contract in the
platform (`CLAUDE.md` `## Types`, `MVP_PLAN_V3.md` §6). Both `platform/telemetry-sdk` and
`platform/api` import it, and every type is derived with `z.infer` — never hand-written
beside the schema it should match.

`index.ts` is the only file outside `schema/`. That is deliberate: it keeps
"`platform/shared/schema/**` is the whole wire contract" literally true. Adding a
non-schema concern to this package means creating a new top-level directory — a visible
act, not a quiet file drop.

## What belongs here

- Zod schemas for anything that crosses a process boundary (SDK → API, API → SDK).
- Types derived from those schemas with `z.infer`.
- Shared primitives (`IdSchema`, `NameSchema`, `TimestampSchema`, `MetadataSchema`) and
  limits (`INGEST_LIMITS`) that both sides of the wire must agree on byte-for-byte.

## What never belongs here

- Prisma types or anything Prisma-shaped. Prisma types are database-internal and never
  cross a module boundary (`CLAUDE.md` `## Types`). Mapping happens explicitly at the
  persistence edge, inside `platform/api`.
- Merge/ordering logic. Tie-breaking equal `occurredAt`, and every other merge rule in
  §12, is `platform/api`'s concern (`p2.merge-rules`). This package validates shape; it
  does not interpret sequences of events.
- A re-export of `zod`. Consumers call `.safeParse()` on the exported schema objects and
  never need a direct `zod` import of their own.

## The envelope is closed, and new types arrive with a `schemaVersion` bump

`TelemetryEventTypeSchema` rejects anything not in `TELEMETRY_EVENT_TYPES`. An unknown
`type` is an **event-level** rejection (`UNKNOWN_EVENT_TYPE`) — it never rejects the whole
batch and never falls through to passthrough acceptance.

Per `docs/decisions/0005-phase-2-wire-contract-gaps.md` decision 3: `TelemetryEventType`
is `Run` and `Step` only in this phase (four values), because Phase 2 has no table to
hold a `decision`/`modelCall`/`toolCall`/`error` event and accepting one with nowhere to
put it is the "green that lies" this project keeps catching late. **New types arrive with
a `schemaVersion` bump** — do not widen `TELEMETRY_EVENT_TYPES` without one.
