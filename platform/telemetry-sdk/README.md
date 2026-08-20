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

`clock` (§17's `Clock`) is injected too, for `occurredAt`. §17 also calls for an injected
`IdGenerator` with seeded implementations of both; that is `p2.sdk-injection`'s deliverable,
and this package deliberately keeps its id generation internal rather than publishing a
surface that packet would then have to change.

### Timers and the host's event loop

`systemScheduler` `unref()`s ordinary timers, so a host that forgets `shutdown()` still exits
the moment its own work is done. Timers scheduled **while `shutdown()` is draining** keep the
process alive instead — §16 makes `await telemetry.shutdown()` required for short-lived
scripts, and a drain the runtime is free to cut short is not a drain. Both halves are proven
against a real spawned process in `test/process-exit.spec.ts`.

## What this package does not do yet

- §15 payload safety — redaction, 32KB-per-field truncation with a `*Truncated` flag, and
  the `captureToolIO` opt-out. Today an event over §12's 64KB per-event cap is dropped and
  counted (`stats().droppedTooLarge`) rather than truncated.
- §17's `IdGenerator` injection and the seeded Clock/IdGenerator pair.
- Decision, ModelCall, ToolCall and Error events. The wire contract carries `run.*` and
  `step.*` only.
