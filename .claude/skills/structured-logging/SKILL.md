---
name: structured-logging
description: Emit progress and failures as one structured event with two renderings — a low-noise coloured console line and a JSONL evidence record — and cite those records as evidence without letting a log authorize its own success. Use when writing or changing anything that reports progress, and when an evidence entry wants to point at a run.
---

# Structured Logging

One event, two sinks. The console line is a rendering of a JSONL record, never a second
source of truth, and the record is what an evidence entry cites.

`scripts/lib/log.ts` is the implementation. `.claude/rules/log-event.schema.json` is the
shape. Do not add a logging dependency; do not start a second sink.

```ts
import { createLogger } from './lib/log.ts';

const log = createLogger({ runId, agent: 'builder', phase: 'p2.sdk-core' });
log.info('BUILD started', { status: 'started' });
log.pass('typecheck 0 errors', { evidenceId, durationMs: 15200, status: 'passed' });
log.finish(); // derived summary, emitted and returned
```

## Console: what a human scans

```text
12:41:03 INFO  [builder/p2.sdk-core] BUILD started
12:41:18 PASS  [runner/p2.sdk-core] typecheck 0 errors · 15.2s · evidence=EV-3f21c084
12:41:26 ERROR [tester/p2.sdk-core] RBAC mismatch · evidence=EV-91ac0b12
```

Six things reach the console: phase start, a meaningful state transition, a gate result, a
retry, a blocker or failure, phase completion, and the final summary.

Nothing else does — not every internal step, not every processed item, not a successful
low-level operation, not repeated context, not a heartbeat. A long phase may emit a bounded
heartbeat when a human would otherwise be unable to tell it apart from a hang.

| Level | Colour     | For                                                |
| ----- | ---------- | -------------------------------------------------- |
| DEBUG | gray       | artifact only at the default threshold             |
| INFO  | cyan       | progression                                        |
| PASS  | green      | a gate that passed, with the evidence that says so |
| WARN  | yellow     | something a reader must not skip past              |
| ERROR | red        | a reproduced failure                               |
| FATAL | bright red | the run cannot continue                            |

Colour is a property of the destination. `NO_COLOR`, a non-TTY stream, a redirect, and CI
all get plain text; `FORCE_COLOR` overrides. The JSONL never carries an escape sequence —
one in a captured artifact is corruption a reader has to strip before the file parses.

## Artifact: what a reader can act on

Default sink `.artifacts/telemetry/events.jsonl`, one JSON object per line, matching
`log-event.schema.json`. Every event lands there, including the `DEBUG` the console hides:
the artifact is the evidence sink, and evidence filtered at write time cannot be recovered.

Failure events carry `failure` with `errorType`, `expected` and `actual`, plus the command,
exit code, retry count and the artifact paths holding stdout, stderr and the stack. The
line summarises; the artifact holds the run.

`classification` stays absent until something other than the log established it. **A failure
log proves the failure it observed. It does not establish the cause.** That is
`diagnostician`'s output, on a reproduction.

## Never in a log

Secrets, credentials, tokens, cookies, connection strings with a password, private keys,
full prompts, whole payloads. `redact()` runs on the way into _both_ sinks — there is no
path by which a secret reaches disk and is scrubbed from the console only — but redaction is
a backstop, not a licence to pass a credential through it.

Strings are truncated at a bound and the full text goes to an artifact.

## One failure, one record

`eventId` is a stable hash of run, agent, phase, task and message. The same failure reported
twice carries the same id, so:

- a repeat is written as `duplicateOf` and never re-rendered on the console
- a retry cites the failure it retries
- a caller re-reporting a callee's error cites the original rather than copying its stack

Two agents reporting one failure at full length reads as two failures.

## PASS costs evidence

`log.pass()` requires an `evidenceId`. A zero exit code is not one — a suite that discovered
nothing exits zero. Log the success **after** the gate that proves it, against the
requirement it proves.

The logger throws on an unsound event: `PASS` without evidence, `ERROR` without expected and
actual, test counts that do not add up, a status outside the allowed set. A logger that
degrades quietly produces exactly the confident, wrong record it exists to prevent.

## The summary is derived

`log.finish()` computes the summary from the recorded events — phases, gates, tests,
retries, unknowns — and returns `DONE` only when nothing failed and nothing is unknown.
Never hand-write those counts. `summaryDisagreements()` is how a reader checks a claimed
summary against the events behind it.

## Logs as evidence

An evidence entry may cite log records:

```
requirement: telemetry events are rejected above the batch limit
expected: HTTP 413, per the §12 limits table
actual: 413 with per-event results
verification: pnpm test --filter api -t 'batch limit'
source: log
eventIds: [ev_3f21c084aa10]
result: PASS
artifact: .artifacts/telemetry/events.jsonl
```

Rules the checker enforces:

- `eventIds` without an `artifact` path is an uncitable reference.
- `source: log` alone cannot carry a `PASS`. A self-reported success log is the claim, not
  the proof; pair it with a test, command, diff, read-back or trace.
- A failure log is sufficient evidence that the failure was observed, and never sufficient
  evidence of its cause.
- High-risk verdicts want two independent sources, not one source twice.

The rest of the evidence contract — what `DONE` costs, which handoff schema, what belongs in
an artifact — is the `report-handoff` skill.
