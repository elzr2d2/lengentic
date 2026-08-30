# @lengentic/telemetry-sdk

The public artifact. A host installs this to emit telemetry, which is why it imports
`@lengentic/shared` and **nothing else** from the platform — a transitive Prisma or Nest
dependency would make every consumer install a database client to send an event
(`pnpm check:boundaries`, rule `sdk-depends-on-shared-only`).

`MVP_PLAN_V3.md` §16 is the contract. The one property everything else serves:

> An observability SDK that blocks its host distorts the system it measures.

## Usage

```ts
import { createTelemetryClient } from '@lengentic/telemetry-sdk';

const telemetry = createTelemetryClient({ endpoint: 'http://localhost:3000' });

const run = telemetry.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
const step = run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
step.complete();
run.complete();

await telemetry.shutdown();
```

Field names are the wire contract's, not §16's illustrative example's: `workflowName` and
`agentName` are what `platform/shared/schema/**` declares, and CLAUDE.md `## Types` makes
that schema the only wire contract. `type` is required because `StepStartedPayloadSchema`
requires it.

`parentStepId` is never passed in. It is resolved structurally: `run.startStep()` is a root
step (`null`), `step.startStep()` is a child of that step.

## The seven properties, and where each one lives

| §16 property | Where                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| Asynchronous | `record` only touches an in-memory queue; nothing on the caller's path awaits I/O       |
| Batched      | `flushIntervalMs` (1s) or `maxBatchSize` (100), whichever comes first                   |
| Bounded      | `BoundedQueue` — drop oldest at `maxQueueSize`, counted in `stats().droppedOverflow`    |
| Silent       | every failure becomes a `TelemetryDiagnostic` on `onDiagnostic`; the default is a no-op |
| Flushable    | `flush()` drains what is queued; `shutdown()` drains and stops                          |
| Retrying     | `maxRetries` attempts + 1, exponential backoff capped at `maxBackoffMs`, FINITE         |
| `shutdown()` | idempotent, bounded by `shutdownTimeoutMs`, resolves even against a dead endpoint       |

### `delivered` vs. what the server actually did with it

`stats().delivered` is a **transport** count — the number of events in batches the
transport reported as having reached the API, regardless of what the API did with them.
A batch the API entirely deduplicated (the same `runId`/`eventId` pair sent twice — a mock
scenario replaying an already-used seed, for example) is still `delivered`: the HTTP
request round-tripped a 2xx, even though nothing new was persisted.

`stats()` additionally carries what the API itself claimed, read from `IngestResponse`
(`platform/shared/schema/ingest.ts`) on every batch whose response body could be parsed:

| Field                     | Meaning                                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverAccepted`          | Events the API says it persisted for the first time                                                                                                                                                                                          |
| `serverDuplicate`         | Events the API recognised as already persisted (same `runId` + `eventId`)                                                                                                                                                                    |
| `serverRejected`          | Events the API refused                                                                                                                                                                                                                       |
| `serverCountsUnavailable` | Events in a delivered batch whose response body could not be read as an `IngestResponse` — kept apart from `serverAccepted: 0` because "the server said zero were new" and "the server's answer could not be understood" are different facts |

Each is a running total across every delivered batch, summed from whatever the API's own
response reported for that batch — nothing here verifies that a single batch's
`accepted + duplicate + rejected` actually equals the batch size the client sent. A caller
that wants to know whether a run created anything new should read `serverAccepted`, never
`delivered`.

### Silent means silent

The SDK never throws into host code. There is exactly one exception, which §16 licenses:
an invalid **initialization** config throws `TelemetryConfigError` at `createTelemetryClient`,
before any event can exist. Everything after that — a payload off the wire contract,
circular data, an oversized event, a dead endpoint, a transport that hangs, a buffer
overflow, even a diagnostic sink that throws — is absorbed, counted in `stats()` and
reported through `onDiagnostic`.

The default sink writes nothing anywhere. An agent's stderr is not LenGentic's to spend.

## Defaults

| Option              | Default | Source                                    |
| ------------------- | ------- | ----------------------------------------- |
| `flushIntervalMs`   | `1000`  | §16                                       |
| `maxBatchSize`      | `100`   | §16 (hard ceiling: §12's 500 per batch)   |
| `maxQueueSize`      | `10000` | this package                              |
| `maxRetries`        | `3`     | this package (§16 requires only "finite") |
| `initialBackoffMs`  | `200`   | this package                              |
| `maxBackoffMs`      | `5000`  | this package                              |
| `requestTimeoutMs`  | `5000`  | this package                              |
| `shutdownTimeoutMs` | `5000`  | this package                              |

## The two injected seams

Both are `TelemetryConfig` fields with real defaults, and both exist because the properties
above are otherwise untestable without waiting real seconds or standing up a real API.

- **`transport`** — `TelemetryTransport`. Batching, retry classification and the retry bound
  are observable through what a test double is handed, with no network involved. The default
  is `createHttpTransport({ endpoint })`.
- **`scheduler`** — `Scheduler`. The flush interval, the request timeout, the retry backoff
  and the shutdown deadline all run on it, so a test drives them by moving a fake clock.
  The default is `systemScheduler`.

`clock` (§17's `Clock`) and `idGenerator` (§17's `IdGenerator`) are injected too, for
`occurredAt` and for every run/step/event id. The runtime defaults are `systemClock` (wall
clock) and `systemIdGenerator` (UUIDv7, time-ordered to the millisecond — there is no
intra-millisecond counter, so ids minted inside one millisecond sort by their random tails).
A mock scenario supplies
`SeededClock`/`SeededIdGenerator` instead: two instances built from the same numeric seed
produce the identical sequence of timestamps or ids, which is what makes replaying the same
scenario twice byte-identical (`docs/decisions/0005-phase-2-wire-contract-gaps.md` depends
on this for the seeded id half). A seeded id's version nibble is fixed to `f`, a value real
UUIDv7 never produces, so a consumer that checks can tell a scenario id from a runtime one.
Nothing checks today — `IdSchema` validates length, not UUID shape — so the nibble is a
convention available to a future consumer, not an enforced boundary.

### Timers and the host's event loop

`systemScheduler` `unref()`s ordinary timers, so a host that forgets `shutdown()` still exits
the moment its own work is done. Timers scheduled **while `shutdown()` is draining** keep the
process alive instead — §16 makes `await telemetry.shutdown()` required for short-lived
scripts, and a drain the runtime is free to cut short is not a drain. Both halves are proven
against a real spawned process in `test/process-exit.spec.ts`.

## §15 payload safety

One shared client-side serializer, in `src/payload-safety.ts`, applied in `handles.ts` — the
only place a payload is built — so every arbitrary JSON field goes through it and none can
be missed. §15's order, run in order:

```text
safe serialization → redaction → size cap / truncation
  → stable sanitized fingerprint where required → enqueue
```

**Safe serialization** survives what `JSON.stringify` cannot: circular references
(`[Circular]`), `BigInt`, `Map`, `Set`, typed arrays, `Date`, `Error`, `NaN`/`Infinity`, and
a getter or `toJSON()` that throws (`[Unreadable: …]`). The sanitized payload still **ships**
— an event is no longer dropped for containing circular data.

**Redaction** ships with §15's three defaults and nothing more: an `Authorization` key, a key
matching `/api[_-]?key/i`, and a value that starts `Bearer …`. Each becomes `[REDACTED]`
before the event enters the buffer, so a secret never reaches the transport. Widening those
patterns is deliberately not done here — a false positive deletes evidence a developer needs
to reconstruct a run.

```ts
const telemetry = createTelemetryClient({
  endpoint: 'http://localhost:3000',
  // Runs BEFORE the shipped defaults, so it can inspect the original value and cannot
  // narrow the floor beneath it. A hook that throws yields `[REDACTED]`, never the original.
  redact: (value, path) => (path.endsWith('.ssn') ? '[MINE]' : value),
  maxFieldBytes: 32 * 1024, // §15 default
  captureToolIO: true, // `false` drops ToolCall input/output, keeps timing and success
});
```

**Size cap**, 32KB per field by default. A field over it is truncated and the `*Truncated`
flag is set; `inputBytes`/`outputBytes` report the size **before** the cap, because
truncation must lose the payload and not the measurement. Truncation keeps as much real
structure as fits — a prefix of an array's elements, as many of a record's keys as the budget
allows — and marks what it dropped (`__lengenticTruncated`, `[truncated: N more item(s)]`).
`maxFieldBytes` is bounded above by §12's 64KB per-event cap: a per-field cap wider than that
cannot hold, because the event would be dropped whole before the field cap mattered.

**Fingerprints** are computed over sanitized, canonicalized data, never over raw secrets —
two different values under a redacted key fingerprint identically, so the hash is not an
oracle for the secret. `fingerprintOf(value)` is exported for §20.2's caller-owned
`inputFingerprint`. The hash is FNV-1a/64, a grouping key and not a cryptographic digest.

```ts
step.recordToolCall({
  toolName: 'http_get',
  input: { url, headers: { Authorization: `Bearer ${token}` } }, // redacted before transmission
  output: hugeResponseBody, // truncated at 32KB, `outputTruncated: true`
  startedAt,
  completedAt,
  success: true,
});
```

## What this package does not do yet

- Decision, ModelCall and Error events. `recordDecision` is `p4.sdk-decisions`; the SDK
  emits `run.*`, `step.*` and `tool_call.recorded` today.
- No wire field carries a tool call's `inputFingerprint`. `fingerprintOf` is exported so a
  caller can compute one, but `tool_call.recorded` has nowhere to put it — see `BACKLOG.md`.
