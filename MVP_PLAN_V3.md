# LenGentic

## Agent Observability & Decision Intelligence Platform

### MVP Implementation Plan — v3

---

# 0. Status of This Document

v3 replaces **`MVP Implementation Plan — v2`** and absorbs
**`docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md`**. Both are
historical from this point. This document is the single executable plan; there is no
longer a second document that wins on conflict.

Four decisions were taken when v3 was authored and are recorded here so they are not
re-litigated:

| #   | Decision                                                                                       |
| --- | ---------------------------------------------------------------------------------------------- |
| 1   | The corrections document is folded in and retired. `CLAUDE.md`'s precedence rule is updated.   |
| 2   | Analysis is **on demand only**. The Postgres job table and in-process worker are removed.      |
| 3   | Handoffs become **file-based**. Phase 1 closes on its existing terms; the retrofit is tracked. |
| 4   | Phase 1 is **not re-opened**. It completes against v2 + corrections; v3 deltas are follow-ups. |

Decision 2 reverses a previously locked decision. It is consistent rather than arbitrary:
once analysis is explicitly triggered, nothing needs a queue. Automatic analysis on
terminal run moves to `BACKLOG.md`.

Decision 3 means §26's handoff contract describes the **target** state. The shipped Phase 1
implementation parses subagent transcripts instead. That gap is a tracked follow-up, listed
under Phase 1 Carried Debt, not a Phase 1 blocker.

---

# PART I — FOUNDATIONS

---

# 1. Product Goal

LenGentic is a provider-agnostic platform for observing, storing, analyzing, and improving
agentic AI systems.

The platform answers four questions:

```text
What happened?
Why did it happen?
Is this behavior repeating?
Can part of this probabilistic behavior become deterministic software?
```

Core product loop:

```text
Observe → Store → Analyze → Recommend
```

The MVP must:

- Run locally end-to-end.
- Require no paid external service.
- Support deterministic Mock Agent scenarios.
- Remain provider-agnostic.
- Keep development agents completely separate from product agents.
- Produce evidence-based recommendations.
- Report evidence _against_ its own recommendations, not only for them.
- Demonstrate production-oriented software engineering practices.

## The product claim — exact wording

> LenGentic observes agent execution, analyzes historical decision patterns, and identifies
> evidence-backed candidates for deterministic defaults — while exposing counterexamples and
> uncertainty.

Do not say LenGentic "learns." No learning system is implemented. Do not adopt the term
"progressive crystallization" — it is taken by prior art. Keep **deterministic candidate**.

---

# 2. Epistemic Position

This section constrains every claim the product makes. It is not boilerplate.

LenGentic observes **chosen options and attested outcomes**. It does not observe
counterfactuals.

```text
LenGentic can say:

  "This decision selected X in N of M observed executions,
   across K distinct contexts, with an attested success
   rate of S%. Here are the M-N cases that did not."

LenGentic must never say:

  "This decision does not require an LLM."
```

Every recommendation is a **hypothesis with attached evidence and counterevidence**,
addressed to a human. The suggested action is always a deterministic default with an escape
hatch, never unconditional replacement.

Say **"attested success rate"**, never "measured success rate". The caller asserts the
outcome; LenGentic has no independent way to verify it.

## Position against prior art

Two systems implement adjacent theses. Recorded because the differentiator is narrow and
must be stated precisely.

|                              | Progressive Crystallization                    | TraceCompiler                       | LenGentic         |
| ---------------------------- | ---------------------------------------------- | ----------------------------------- | ----------------- |
| Promotion gate               | ≥10 successful runs, ≥90% same action sequence | Argument-level provenance           | Five gates, G1–G5 |
| **Context-diversity gate**   | **No**                                         | **No**                              | **Yes — G2**      |
| **Counterexample reporting** | **No**                                         | **No** — refuses to compile instead | **Yes**           |
| Regression handling          | Circuit-breaker demotion                       | Not addressed                       | **None (MVP)**    |

Two consequences:

1. **G2 is the differentiator.** Ten runs of the same situation and ten runs of ten
   different situations are indistinguishable under a pure dominance gate, and they are
   _opposite_ findings. G2 separates them.
2. **Counterexample reporting is unclaimed.** TraceCompiler _refuses_ under uncertainty;
   LenGentic _discloses_. Refusal hides the judgment call from the engineer; disclosure
   hands it to them.

Recorded non-goal, for honesty: LenGentic has **no demotion mechanism**. An accepted default
that stops holding is not detected. The README's limits section must say so. `BACKLOG.md`'s
shadow mode is the honest future version.

---

# 3. Architecture Overview

Three separate systems in one repository.

```text
┌──────────────────────────────────┐
│      Engineering Harness         │
│       Claude Code Agents         │
│                                  │
│ Architect  Builder               │
│ Validator  Reviewer              │
│                                  │
│ (escalation only)                │
│ Diagnostician  Reflector         │
└────────────────┬─────────────────┘
                 │ builds
                 ▼
┌──────────────────────────────────┐
│        LenGentic Platform        │
│                                  │
│ Telemetry API      PostgreSQL    │
│ Analysis Engine    Dashboard     │
│ Recommendations    Telemetry SDK │
└────────────────▲─────────────────┘
                 │ telemetry
┌────────────────┴─────────────────┐
│           Playground             │
│ Product Agents   Providers       │
│ Tools            Scenarios       │
└──────────────────────────────────┘
```

---

# 4. Hard Architecture Boundaries

## Allowed

```text
Playground → Telemetry SDK → Platform
```

## Forbidden

```text
Platform          → Playground
Platform Runtime  → .claude/
Playground Runtime → Engineering Agents
```

Additionally:

```text
platform/telemetry-sdk → platform/shared        ALLOWED
platform/telemetry-sdk → platform/api           FORBIDDEN
platform/telemetry-sdk → platform/analysis-engine  FORBIDDEN
platform/telemetry-sdk → Prisma                 FORBIDDEN
```

The SDK is the public artifact. A transitive Prisma dependency would make every consumer
install a database client to emit telemetry.

`.claude/` is development infrastructure only. LenGentic must run correctly if `.claude/` is
removed. The Platform must run correctly if the entire Playground is removed.

**These are verified mechanically, never by review.** See §7.

---

# 5. Repository Structure

```text
/
├── .claude/
│   ├── agents/  skills/  hooks/  rules/  settings.json
│
├── .artifacts/
│   └── handoffs/            ← agent handoff JSON, not a runtime dependency
│
├── platform/
│   ├── api/  dashboard/  telemetry-sdk/
│   ├── analysis-engine/  shared/  database/
│
├── playground/
│   ├── agents/  providers/  tools/
│   ├── workflows/  scenarios/  fixtures/
│
├── spike/                   ← Phase 0 only, deleted after Phase 5
├── docker/
├── docs/
│
├── CLAUDE.md  MVP_PLAN.md  BACKLOG.md  README.md
├── docker-compose.yml  package.json  pnpm-workspace.yaml
```

`.artifacts/` is build/process output. It is gitignored, never imported by runtime code, and
its absence must not break any build.

---

# 6. Locked Technology Stack

Do not revisit without a demonstrated blocking technical issue.

| Area                 | Choice                                                    |
| -------------------- | --------------------------------------------------------- |
| Runtime              | Node.js LTS, TypeScript                                   |
| Packages             | pnpm, pnpm workspaces                                     |
| Backend              | NestJS, REST, Zod for shared runtime schemas              |
| Frontend             | Next.js, React, TypeScript                                |
| Database             | PostgreSQL, Prisma ORM                                    |
| Testing              | Vitest, Nest testing utilities, Supertest, Testcontainers |
| Infrastructure       | Docker, Docker Compose                                    |
| Boundary enforcement | dependency-cruiser                                        |
| CI                   | GitHub Actions                                            |

**Not in the stack, and not to be added:** Redis, BullMQ, pg-boss, any job runner, any
message broker, any vector database, LangChain, LangGraph, RAG infrastructure.

## One wire contract, three type sources

```text
platform/shared/schema/**   Zod. The ONLY wire contract.
                            Imported by telemetry-sdk AND api. Types via z.infer.

Prisma types                Database-internal. Never cross a module boundary.

Mapping                     Explicit mappers at the persistence edge.
                            No Prisma model is ever returned from a controller.
```

## Test database strategy

**Testcontainers**, pinned image (`postgres:17.x`, exact tag, never `latest`).

```text
Unit          Vitest, pure functions, no container. The analysis engine lives here.
Integration   One container per test file. `prisma migrate deploy` on boot,
              truncate between tests. Supertest against a real Nest app.
E2E           One container for the suite.
```

The analysis engine is deliberately pure and fixture-driven, so the bulk of the
correctness-critical logic needs no container and runs in milliseconds.

---

# 7. Mechanically Enforced Boundaries

## `pnpm check:boundaries`

dependency-cruiser. Runs on every gate invocation. Encodes every rule in §4.

**A boundary rule that has never failed is not known to work.** Each rule must be proven to
fail on a deliberate violation at least once, including a **type-only** import, which
requires `tsPreCompilationDeps`.

## `pnpm check:isolation`

Two arms. Not three.

```text
Arm 1  platform without playground/   FULL install + build + test in temp checkout   CI only
Arm 2  platform without .claude/      STATIC check                                   every run
```

Arm 1 must strip playground-referencing root scripts as part of the isolation script, so it
tests _imports_, not _script bookkeeping_.

Arm 2 is nearly free and already covered by dependency-cruiser. A full rebuild to prove it
adds minutes and no information.

## Gate tiers

```text
pnpm gates       lint, format:check, typecheck, test, build, check:boundaries
pnpm gates:full  gates + check:isolation          CI and pre-commit only
```

Mechanical checks are **tooling, not agents**. Never ask an agent to verify something a
script can verify. Forbidden imports are `check:boundaries`; Reviewer does not check them.

---

# 8. Scope Management Rule

```text
Is it required for the current phase Definition of Done?

  yes → implement it
  no  → BACKLOG.md
```

Do not expand the current phase. Do not automatically start the next phase. Do not create
sub-phases (`3A`, `4B`, `5C`). A phase may contain tasks but remains one delivery milestone.

Every completed phase must leave the repository runnable.

---

# 9. Engineering Harness

The **main Claude Code session is the Coordinator.** Do not create a coordinator agent.

## Agents and when they run

| Agent         | When                                                          | Model       |
| ------------- | ------------------------------------------------------------- | ----------- |
| Architect     | Phase framing, or a genuinely ambiguous / high-risk decision  | Opus High   |
| Builder       | Primary implementation owner                                  | Sonnet High |
| Validator     | Behavioral validation after an executable work packet         | Sonnet      |
| Reviewer      | Phase gate, or high-risk interface / schema / analyzer change | Sonnet High |
| Diagnostician | Only when Validator cannot localize a reproduced failure      | Opus High   |
| Reflector     | Only after the same mistake pattern recurs at least twice     | Opus        |

Diagnostician and Reflector are **created only when a real failure demands them**, and the
triggering failure is recorded in `BACKLOG.md`. If neither is ever created, that is a valid
outcome.

**Do not run Architect, Validator, and Reviewer after every minor edit.**

## Role separation is structural

Reviewer has no `Write`/`Edit`. Validator has no `Edit` — it may `Write` new test files and
fixtures only. Creating a source file to work around a defect is a role violation, not a
clever use of tools. Do not add these tools back.

Validation and implementation are separate responsibilities. A Reviewer that silently fixes
its own finding has destroyed the separation the role exists for.

## Default delivery loop

```text
Coordinator frames work packet
  → Builder implements
  → Validator validates behavior
  → Builder repairs validated failures
  → Reviewer reviews at the phase gate
  → deterministic gates
  → human approval before next phase
```

Escalation:

```text
Architecture uncertainty            → Architect
BLOCKED handoff, cause unclear      → Diagnostician
Same mistake pattern twice          → Reflector
```

## Engineering agents are never runtime dependencies

LenGentic must run correctly if `.claude/` is deleted, and the Platform must run correctly
if the entire Playground is deleted.

---

# 10. Agent Handoff Contract

Handoffs are **files**, not parsed chat responses. Parsing a subagent's final message
depends on the model's formatting and fails silently when it changes.

```text
.artifacts/handoffs/<phase>-<task>-<role>.json
```

Validated by a deterministic JSON Schema script — `.claude/rules/handoff.schema.json` — run
as a gate, not by an agent.

## Required fields

```text
phase                  e.g. "1"
taskId                 stable id for the work packet
role                   architect | builder | validator | reviewer
status                 PASSED | FAILED | BLOCKED
summary                one sentence
evidence               array; non-empty when status is FAILED
commandsRun            array of strings, verbatim
expected
actual
affectedArea
recommendedNextAction
confidence             HIGH | MEDIUM | LOW
```

## Status semantics

```text
PASSED    validation ran and the behavior matched.
FAILED    a mismatch was REPRODUCED, with evidence.
BLOCKED   validation could not be completed, or the cause remains unclear.
```

`FAILED` requires reproduction. An unevidenced failure is an opinion.

**Unclear root cause triggers Diagnostician from `BLOCKED`** — not from a low-confidence
`FAILED`. A blocked validation reported as a failure sends Builder hunting a defect that may
not exist.

Never report `PASSED` on unrun commands. Claiming so is worse than reporting `BLOCKED`.
---

# PART II — CONTRACTS

Settled here, once. The Builder does not invent any of this.

---

# 11. Identifier Model

Span-shaped identifiers. This is not an OpenTelemetry integration — OTel stays out of scope
— but adopting the _shape_ makes future compatibility a mapping instead of a rewrite.

```text
Run   ≈ trace
Step  ≈ span
```

All IDs are **client-generated**, UUIDv7 preferred for time-ordered indexes.

Client-generated IDs are what make ingestion idempotent. Without them an SDK retry after a
timeout creates a duplicate, and duplicates inflate exactly the counters the deterministic
analyzer depends on.

`Run.traceId` is always equal to the PK, reserved for future fan-out. Keep it, with that
justification as a schema comment — a reviewer will otherwise flag it as redundant every
time.

---

# 12. Ingestion Envelope

**Event identity and entity identity are separate.** Conflating them makes a completion
event either a duplicate or a new row, and both are wrong.

```ts
interface TelemetryEvent {
  eventId: string; // idempotency key
  schemaVersion: '1';
  type: TelemetryEventType;
  entityId: string; // the Run/Step/Decision/ModelCall/ToolCall/Error updated
  runId: string;
  occurredAt: string; // client clock
  payload: unknown;
}
```

```text
eventId      The idempotency key. Re-posting a known eventId is a no-op.
entityId     Identifies the entity being created or updated.
occurredAt   Client time. Authoritative for ordering and duration.
receivedAt   Server-generated. Stored separately.
```

Start and completion events carry **different `eventId` values** and **the same
`entityId`**.

**Never combine client and server clocks in one duration calculation.**

## Merge rules — deterministic, not left to the Builder

```text
Out-of-order start/completion
  A completion event for an unseen entityId creates the row in a
  completed state. The later-arriving start event fills in start
  fields only; it never resets status.

Field precedence
  Start fields (startedAt, name, type, parent) — first writer wins.
  Completion fields (completedAt, status, output) — last writer wins
  by occurredAt, not arrival order.

Conflicting terminal states
  COMPLETED and FAILED for the same entityId: FAILED wins.
  A failure that was observed is more informative than a success that
  was also observed, and silently picking the later one makes the
  result depend on network timing.

Late events on a terminal Run
  Accepted. They update lastEventAt and may enrich the run.
  They MUST NOT reopen it.

Orphans
  A Step may arrive before its parent. parentStepId has NO foreign key.
  Hierarchy resolves at read time. Orphaned steps are surfaced in the
  Run Explorer, never silently dropped.
```

## Limits and rejection

```text
Max events per batch        500
Max request body            5 MB
Max single event payload    64 KB after client-side capping

Request-level rejection (whole batch rejected, HTTP 400)
  - body exceeds max request size
  - body is not valid JSON
  - events array missing, empty, or over max batch size

Event-level rejection (batch still processed, HTTP 207-style body)
  - unknown or missing schemaVersion
  - unknown type
  - missing eventId / entityId / runId / occurredAt
  - payload fails its Zod schema
```

A malformed event never rejects the whole batch. One bad event in a 500-event flush must not
discard 499 good ones.

## Response shape

```ts
interface IngestResponse {
  batchId: string;
  accepted: number;
  duplicate: number;
  rejected: number;
  results: Array<{
    eventId: string;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    error?: { code: string; message: string };
  }>;
}
```

`DUPLICATE` is a success, not an error. It is the idempotency contract working.

## Endpoint

```text
POST /v1/telemetry/events
```

Accepts a batch. Single-event posts are a batch of one.

---

# 13. Domain Model

## Run

```text
id                 client-generated, PK
traceId            = id (reserved for future fan-out)
workflowName
workflowVersion    caller-supplied, required
status             RUNNING | COMPLETED | FAILED
startedAt          client clock
completedAt        client clock
receivedAt         server clock
lastEventAt        server clock
metadata
createdAt
```

Derived, not stored:

```text
STALE = status == RUNNING AND now - lastEventAt > STALE_RUN_THRESHOLD

STALE_RUN_THRESHOLD = 30 minutes    configurable; see OD-1
```

`STALE` runs are excluded from all historical aggregation.

## Step

```text
id                 client-generated, PK (= spanId)
runId
parentStepId       nullable, NO foreign key constraint
name
agentName
type
status
startedAt / completedAt   client clock
receivedAt                server clock
metadata
```

## Decision

```text
id
runId
stepId

decisionType          the recurring decision point being analyzed
contextKey            caller-supplied, required — a bucket describing the situation
contextKeyVersion     caller-supplied, required — version of the bucketing strategy
rawContext            JSON, size-capped, redacted

availableOptions
selectedOption

outcome               SUCCESS | FAILURE | UNKNOWN
outcomeAttestedBy     CALLER | UNKNOWN
outcomeObservedAt

createdAt
```

Do not store hidden model chain-of-thought.

### Execution strategy is an ordinary Decision

The Playground's sequential-vs-parallel choice (§29) uses this entity unchanged. There is no
awareness-specific table, no second decision pipeline, and no new event type.

```text
decisionType        execution_strategy
availableOptions    [sequential, parallel]
selectedOption      sequential | parallel
rawContext          the awarenessContext object — §29, capped and redacted per §15
contextKey          coarse, caller-computed — §14
```

The outcome of the strategy is the existing `outcome` / `outcomeAttestedBy` /
`outcomeObservedAt` columns, written by the same idempotent attestation event keyed on
`decisionId`. Correlation is already `Run → Step → Decision` by client-generated id; nothing
new is required to answer _"which strategy did this run pick, and how did it end."_

Token usage stays on `ModelCall`. Do not copy it onto the Decision — a second denominator
for the same tokens is how a run's cost gets double-counted.

## ModelCall

```text
id  runId  stepId
provider  model
latencyMs
inputTokens  outputTokens      optional
status  metadata  createdAt
```

## ToolCall

```text
id  runId  stepId
toolName
input / output                 size-capped, redacted
inputTruncated / outputTruncated
inputBytes / outputBytes
startedAt / completedAt / durationMs
success  error
```

## Error

```text
id  runId  stepId
type  message  metadata  createdAt
```

---

# 14. On `contextKey`

Normalization is the hardest problem in the product:

```text
Too coarse  →  distinct decisions merge   →  fake dominance
Too fine    →  sample size never reached  →  no output
```

**The caller owns normalization.** The instrumented system supplies `contextKey`, a short
stable string it computes itself. The Platform groups by it and never infers it. The
Platform does not know what makes two contexts equivalent in the caller's domain; the caller
does. The alternative — platform-inferred normalization with an LLM — is the hardest part of
TraceCompiler, and it is not the MVP.

```text
rawContext stored alongside the key
  → re-normalization possible without losing history

contextKeyVersion stored
  → a change in normalization strategy SPLITS groups
    instead of silently corrupting them
```

If a caller supplies no `contextKey`, the decision is stored but **excluded from
aggregation**. Silent inclusion under a default key is how fake dominance gets manufactured.

## Cardinality is the caller's obligation

A `contextKey` derived from anything unbounded defeats G2 in the opposite direction: every
decision lands in its own bucket, `sampleCount` per situation never reaches G1, and the group
produces nothing forever. The Platform cannot detect this for the caller — a high-cardinality
key looks exactly like a legitimately diverse one until the data runs out.

```text
Forbidden as key dimensions   run ids, task ids, span ids, file paths,
                              timestamps, durations, free text, hashes
Sound key dimensions          coarse enumerated buckets, few values each
```

For `execution_strategy` (§29) the recommended derivation is five coarse dimensions:

```text
risk bucket                low | medium | high | unknown
task-count bucket          1 | 2-3 | 4-8 | 9+
dependency bucket          none | resolved | unresolved
resource conflict          present | absent
validation readiness       ready | not-ready
```

`workflowName`, `workflowVersion` and `contextKeyVersion` are already the group key (§18) and
must not be repeated inside the `contextKey`.

## On `outcome` and `outcomeAttestedBy`

The outcome comes from the caller. In the MVP the Playground both generates decisions and
grades them — it is marking its own homework. That is acceptable, but it must be **visible**.
`outcomeAttestedBy` records it, and every surface says "attested success rate."

`outcomeAttestedBy` stays `CALLER | UNKNOWN`. An `INFERRED` value has no producer and would
be speculative schema.

## Attestation crosses process boundaries

Outcomes are usually known later, sometimes after the emitting process has exited. So
attestation is an **independent, idempotent telemetry event** keyed on `decisionId`.

```ts
const decision = step.recordDecision({/* ... */});
decision.id; // client-generated, stable, safe to persist

decision.attestOutcome('SUCCESS'); // same process, later

telemetry.attestOutcome(decisionId, 'SUCCESS', { observedAt }); // any process, hours later
```

Re-attesting the same `decisionId` overwrites `outcome`, `outcomeAttestedBy`, and
`outcomeObservedAt` — last write wins. An attestation for an **unknown** `decisionId` is
accepted and stored, not rejected; decisions and attestations may arrive out of order like
any other event pair.

---

# 15. Payload Safety

Applies to **every arbitrary JSON field**, not only ToolCall input/output:

```text
Run.metadata      Step.metadata      Decision.rawContext
ModelCall.metadata  ToolCall.input/output  Error.metadata
```

One shared client-side safe serializer. Required order:

```text
safe serialization → redaction → size cap / truncation
  → stable sanitized fingerprint where required → enqueue
```

```text
Size cap        Default 32KB per field. Exceeding truncates and sets the
                *Truncated flag. Never silently store a 4MB blob.

Redaction hook  redact?: (value: unknown, path: string) => unknown
                Runs client-side, before transmission. Ships with defaults for
                common credential shapes (Authorization headers, /api[_-]?key/i,
                bearer tokens).

Opt-out         captureToolIO: false disables input/output capture entirely
                while retaining timing and success data.
```

Safe serialization must survive circular references, `BigInt`, `Map`/`Set`, and getters that
throw.

**Fingerprints are computed over sanitized, canonicalized data. Never fingerprint raw
secrets.**

---

# 16. Telemetry SDK

```text
platform/telemetry-sdk
```

The SDK must not depend on any AI provider, and must not import anything from the platform
except `platform/shared`.

## Non-negotiable transport requirements

An observability SDK that blocks its host distorts the system it measures.

```text
Asynchronous  Events go to an in-memory queue. Calling code never awaits a
              network round trip.

Batched       Flush on interval (default 1s) or buffer size (default 100),
              whichever comes first.

Bounded       Maximum buffer size. On overflow, drop oldest and increment a
              dropped counter. Never grow without limit.

Silent        The SDK NEVER throws into host code. Transport failures are
              logged to a configurable sink and counted. An agent must not
              crash because LenGentic is down.

Flushable     await telemetry.shutdown() drains the queue. Required for
              short-lived processes and scripts.

Retrying      Bounded retry with timeout and exponential backoff. Retry count
              is configurable and FINITE. This is what exercises the
              idempotency contract in practice.
```

The record methods must not throw because of circular data, redaction failure,
serialization failure, transport failure, or buffer overflow.

**Invalid SDK initialization config MAY fail fast with a clear error.** That is a
programming error at startup, not a runtime telemetry event. Runtime recording stays
isolated.

## Example

```ts
const run = telemetry.startRun({ workflow: 'demo-workflow', workflowVersion: 'a1b2c3d' });
const step = run.startStep({ agent: 'demo-agent', name: 'execute' });
step.complete();
run.complete();
await telemetry.shutdown();
```

---

# 17. Determinism — Clock and IdGenerator

"Same seed → byte-identical telemetry" is impossible with UUIDv7 and wall-clock timestamps.
Both are injected.

```ts
interface Clock {
  now(): Date;
}
interface IdGenerator {
  next(): string;
}
```

```text
Runtime         RealClock   + UUIDv7 generator
Mock scenario   SeededClock + SeededIdGenerator
```

The same scenario seed must generate identical IDs, timestamps, decisions, and payloads.
This is what makes Phase 6's scenarios reproducible and what makes a diff of two scenario
runs meaningful.

---

# 18. Decision Aggregation

## Group key

```text
Group key   (workflowName, workflowVersion, decisionType, contextKeyVersion)
Dimension   contextKey — measured WITHIN the group, never part of its identity
```

`contextKey` is a **diversity bucket inside** the group. Putting it in the group identity
pins `distinctContextKeyCount` to 1 and makes G2 unsatisfiable — no recommendation would
ever be emitted.

The claim LenGentic is licensed to make is _"this option wins across varied situations."_
That requires one group spanning many situations. Per-`contextKey` grouping supports a
finer claim — _"in situation A, always YES"_ — which is more actionable, needs far more data
per group, and directly contradicts G2. It is a legitimate v2 analyzer, recorded in
`BACKLOG.md` as **Context-conditional defaults**. It is not the MVP.

Groups whose `workflowVersion` or `contextKeyVersion` changed mid-history are **split**, not
merged.

`decisionType = execution_strategy` (§29) is an ordinary group. It gets no exemption, no
private threshold, and no separate verdict token. Until G1–G5 all pass it is `SUPPRESSED`,
which is this plan's "insufficient evidence" — LenGentic has observed which strategy the
orchestrator chose, and that is not yet a reason to choose it again. `evaluatorVersion`
belongs in `contextKeyVersion`'s company: bumping it must split groups, never blend them.

## Computed values

```text
sampleCount
distinctContextKeyCount
optionDistribution
dominantOption
dominancePercentage
dominantOptionAttestedSuccessRate
minorityOptionAttestedSuccessRate
outcomeCoverage
dominantOptionFailures
minorityOptionSuccesses
minorityContextConcentration
```

## Explicit denominators

A decision's **selection** is observed even when its **outcome** is not. Selection-based
metrics include `UNKNOWN`; outcome-based metrics do not.

```text
eligible            = decisions after excluding STALE runs and null contextKey
sampleCount         = |eligible|                      # INCLUDES UNKNOWN outcomes
distinctContextKeyCount = |distinct contextKey in eligible|
optionDistribution  = count by selectedOption over eligible
dominancePercentage = max(optionDistribution) / sampleCount

attested            = eligible where outcome != UNKNOWN
outcomeCoverage     = |attested| / sampleCount
attestedSuccessRate(option) =
      |attested where selectedOption == option AND outcome == SUCCESS|
    / |attested where selectedOption == option|
```

Excluding `UNKNOWN` from `sampleCount` would pin `outcomeCoverage` to 100% and make G5
unsatisfiable.

`attestedSuccessRate` is **undefined** when the denominator is 0. It is not zero. G5 is
evaluated first in that case and suppresses the group; G4 reports `N/A`, never `FAIL`, and
never `0%`. Rendering an unknown rate as `0.0%` is exactly the lie §2 forbids.

## `minorityContextConcentration`

A group-by over the minority rows. Converts the counterexample block from a list into a
recommendation about _where the escape hatch goes_.

```text
3 counterexamples, all in post_refactor_large_diff
```

names the escape-hatch condition directly. Compare:

```text
3 counterexamples across 3 different contexts
```

which says the boundary is not context-shaped and the branch is doing something `contextKey`
does not capture — a materially different and more cautionary finding.

---

# 19. Safety Gates

All gates must pass. Every threshold is configurable. **Every failed gate is reported by
name — all of them, not the first.**

```text
G1  sampleCount              >= minSampleCount        default 30
G2  distinctContextKeyCount  >= minDistinctContexts   default 5
G3  dominancePercentage      >= dominanceThreshold    default 90%
G4  dominantOptionAttestedSuccessRate >= successThreshold   default 90%
G5  outcomeCoverage          >= coverageThreshold     default 80%
```

G4 evaluates **the dominant option specifically**. A blended success rate across all options
can clear the gate while the option being recommended is the one that fails.

## Reporting rule

Verdict is `SUPPRESSED` if any gate fails; the report lists **every** failing gate.
"Suppressed by G2" when it also fails G4 understates the problem, and an engineer who fixes
only context diversity returns to find it still suppressed.

## Why G2 exists

If fifty samples all share one `contextKey`, 98% dominance says nothing about whether the
decision is trivial. It says the agent kept encountering the same situation. Dominance under
context uniformity is an artifact of the sample, not a property of the decision.

G2 turns "this option wins" into "this option wins **across varied situations**," which is
the only version of the claim that supports a deterministic default.

## What no gate can fix

None of these gates produce a counterfactual. LenGentic never observes what would have
happened had the minority option been chosen. That is why the minority branch is reported
rather than averaged away, and why the suggested action is a default with an escape hatch
rather than a replacement.

---

# 20. Analyzers

Exactly two. Both pure, both fixture-driven.

## 20.1 Deterministic Candidate

Consumes §18's aggregation, applies §19's gates, emits at most one recommendation per group.

**Counterexamples must include both:**

```text
- cases where the DOMINANT option FAILED
- cases where a MINORITY option SUCCEEDED
```

The `counterexamples` field is **always present**. It may be empty; it is never omitted.

## 20.2 Repeated Failed Action

Generic repeated-sequence and arbitrary loop detection is **out of scope**. It is a research
problem and its false-positive rate is what kills a recommendations product.

Emit only when **all** conditions hold:

```text
Same toolName
Same sanitized inputFingerprint
Result is FAILED or records an Error
At least three CONSECUTIVE attempts
No successful attempt between them
```

Must emit:

```text
run_tests("checkout.spec.ts") → FAILED
run_tests("checkout.spec.ts") → FAILED
run_tests("checkout.spec.ts") → FAILED
```

Must stay silent:

```text
process(item-1) → SUCCESS
process(item-2) → SUCCESS
process(item-3) → SUCCESS
```

`inputFingerprint` is a stable hash over sanitized, canonicalized ToolCall input.

**Do not claim to detect every type of agent loop.** The README and the recommendation text
both say "repeated failed action," never "loop detection."

---

# 21. Recommendation Entity and Lifecycle

## Persisted fields

```text
analyzerId
analyzerVersion
configSnapshot        the thresholds in force when this was produced
sourceWatermark       what data range it was computed over
fingerprint
evidence
counterexamples
firstSeenAt
lastSeenAt
status
```

`configSnapshot` matters: a recommendation produced under a 30-sample threshold means
something different from one produced under 50, and without the snapshot the difference is
invisible.

## Status — two values only

```text
OPEN
DISMISSED
```

```text
PATCH /v1/recommendations/:id/status   { status, note? }
```

Rules:

```text
Re-analysis with the same fingerprint UPDATES evidence and lastSeenAt.
  It does not insert a duplicate.

DISMISSED stays DISMISSED.

A new workflowVersion, contextKeyVersion, or analyzerVersion produces a NEW
fingerprint, and therefore a new recommendation.
```

Do **not** implement "resurface when evidence materially changes" until "materially" has a
tested definition. Without one it becomes "always," and the dashboard is noise within a day.

Recommendation outcome tracking is Post-MVP.

## No `severity`

`severity` is removed from deterministic-candidate recommendations. No deterministic
calculation for it was ever specified, and an arbitrary label attached to evidence-based
output undermines the evidence. Show the actual gate results instead.

## Required output shape

```text
Category:  DETERMINISTIC_CANDIDATE

Deterministic default candidate:
run_tests_after_code_change

Workflow:            demo-workflow @ a1b2c3d
Samples:             50
Distinct contexts:   12
Distribution:        YES 49 (98.0%) | NO 1 (2.0%)
Attested success:    96.0%  (caller-attested, dominant option)
Outcome coverage:    94.0%

Gates:
  G1 sample_count       PASS  (50 >= 30)
  G2 context_diversity  PASS  (12 >= 5)
  G3 dominance          PASS  (98.0% >= 90.0%)
  G4 outcome_success    PASS  (96.0% >= 90.0%)
  G5 outcome_coverage   PASS  (94.0% >= 80.0%)

Suggested action:
Consider a deterministic default of YES for this decision, with an
explicit escape hatch for the conditions below. This would remove a
model call from the hot path while preserving the branch.

Counterexamples (1):
  - run 8f2a…
    contextKey: post_refactor_large_diff
    selected:   NO
    outcome:    SUCCESS

  Concentration: 1 of 1 counterexample in post_refactor_large_diff

Note:
LenGentic observes chosen options only. It cannot determine what would
have happened had the minority option been selected. Review the
counterexamples before removing the branch.
```

The `Note` block is not boilerplate. It is the difference between a recommendation and an
overclaim.

---

# 22. Analysis Trigger

Analysis is **explicit and on demand**.

```text
POST /v1/analysis/run
```

An `Analyze` action is also exposed in the Dashboard.

Scenario flow:

```text
Generate Runs → telemetry.shutdown() → Trigger Analysis → Open Dashboard
```

**No Redis. No BullMQ. No worker service. No job table. No in-process queue.** Automatic
background analysis on terminal Run is in `BACKLOG.md`.

Analysis must not run inline with ingestion — but "not inline with ingestion" is satisfied
by a separate explicit endpoint, which is the simplest thing that satisfies the Definition
of Done.

---

# 23. Run Summary

Observability, not a third analyzer. Aggregated from already-stored telemetry.

```text
Model call count
Input tokens
Output tokens
Total model latency
Tool call count
Failed tool call count
Repeated failed actions
Dropped telemetry event count
```

`Dropped telemetry event count` is reported because a summary computed over silently
truncated data is misleading, and the SDK already counts drops.

Cost calculation, a provider price database, provider benchmarking, and automatic model
routing are **Post-MVP**. Do not add a Cost Optimizer.
---

# PART III — PHASES

One disposable spike plus seven implementation phases. No sub-phases.

```text
0. Thesis Spike            (disposable, no infrastructure)
1. Foundation + Infrastructure
2. First Vertical Slice
3. Minimal Playground
4. Rich Telemetry + Run Explorer
5. Analysis Engine
6. Reproducible Scenarios
7. Portfolio Polish
```

Every implementation phase carries at most **five major work packages**, each with a named
owner, acceptance criteria, concrete validation commands, a Definition of Done, and a human
approval gate. **Do not automatically start the next phase.**

## Execution order amendment — 2026-08-16

**Phase numbers above are identity, not sequence.** A human amended the running order at the
Phase 1 gate. Phase 5 splits at its own wave boundary and its first half runs next, before
Phase 2:

```text
0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7
```

`5a` is Phase 5 waves 1–3 — `p5.engine-pkg`, `p5.negative-fixtures`, `p5.det-candidate`,
`p5.repeated-failed`. Pure functions over fixtures. No database, no HTTP, no SDK, no UI.
`5b` is Phase 5 waves 4–6 — persistence, the analysis endpoint, and the Dashboard. It stays
downstream of Phases 2 and 4 because it cannot exist without them.

**Rationale.** The product's differentiator is the refusal — gates G1–G5, counterexamples,
`N/A` never `0.0%`. Phase 0 proved it and §6 already states the engine needs no container.
Leaving it behind 34 deliverables gated on a Zod schema defers the only work that can
falsify the thesis. Reordering costs nothing now and is expensive once the ingest pipeline
exists.

**Rejected: renumbering.** Task IDs stay `p5.*` and section numbers stay put. Renumbering
would rewrite `scripts/oracle/graph.json`, `docs/PARALLEL_EXECUTION.md`, every plan
cross-reference and the git trail, and manufacture a new generation of stale citations for
no behavioral gain.

**Rejected: a second front.** Running 5a concurrently with Phase 2 was rejected on two
independent grounds — see `.artifacts/plans/phases-2-7-execution-plan.md` §6b. 5a runs
alone, sequentially, and takes its own human approval gate.

**Types in 5a are engine-local.** `platform/analysis-engine` defines its own input and
output types in plain TypeScript, graduated from `spike/types.ts`. It does **not** create or
import `platform/shared/schema`. §6's "one wire contract" binds what crosses a process
boundary; nothing in 5a crosses one. The Zod schema and an explicit mapper land in 5b, when
the API first serves a Recommendation over HTTP.

Testing ownership is distributed, not deferred:

| Phase | Owns these tests                                                |
| ----- | --------------------------------------------------------------- |
| 1     | Base CI, build, lint, typecheck, boundaries, foundation tests   |
| 2     | Ingestion, idempotency, ordering, stale-run integration tests   |
| 3     | Seed reproducibility, Playground isolation                      |
| 4     | SDK buffering, retry, redaction, truncation, Run Explorer       |
| 5     | Analyzer tests written **negative-first**, dedupe, persistence  |
| 6     | Reproducible scenario E2E                                       |
| 7     | Full regression, Docker smoke, documentation, demo verification |

Phase 7 may harden or combine tests. It must **not** introduce the first meaningful tests
for earlier behavior.

---

# PHASE 0 — THESIS SPIKE

**Status: COMPLETE.**

## Objective

Validate or kill the core thesis before building four phases of infrastructure to serve it.
The riskiest assumption is not "can we store telemetry," it is:

```text
Does decision aggregation produce recommendations
that a competent engineer agrees with?
```

That needs a function and some fixtures — no database, no API, no dashboard, no agents.

**Time-box: one day.** Running long is itself a finding.

## Scope

```text
spike/
├── fixtures/decisions.json
├── aggregate.ts
└── report.ts
```

```text
No database   No HTTP   No NestJS   No UI   No agents
Pure functions only
```

`pnpm spike` requires a root `package.json` and a TypeScript runner. "No infrastructure"
prohibits database, HTTP, NestJS, UI, and agents — not a package manifest. `tsx` +
`typescript` only.

## Fixtures — one namespace, split by analyzer

| Prefix      | Analyzer                | Introduced | Count |
| ----------- | ----------------------- | ---------- | ----- |
| `D1`–`D9`   | Deterministic candidate | Phase 0    | 9     |
| `D10`–`D11` | Deterministic candidate | Phase 5a   | 2     |
| `R1`–`R4`   | Repeated failed action  | Phase 5a   | 4     |

Phase 0 defines **all five gates** and carries a dedicated suppressor for each, so no gate
graduates into Phase 5 unexercised.

`D10` and `D11` are Phase 5a additions, not Phase 0 fixtures. Phase 0 achieved one dedicated
suppressor per gate, which is a different and weaker property than the 5a Definition of Done
requires — see **Gate expectation grid** in Phase 5 for what each of them closes.

| ID   | Shape                                                                    | Expected                                 |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `D1` | 50 samples, 12 contexts, YES 49 / NO 1, coverage 94%, success 96%        | **CANDIDATE**, 1 counterexample          |
| `D2` | 40 samples, 9 contexts, SKIP 37 / RUN 3, coverage 90%, success 92%       | **CANDIDATE**, 3 counterexamples         |
| `D3` | 50 samples, 10 contexts, YES 47 / NO 3; all 3 NO succeeded, 4 YES failed | **CANDIDATE**, minority branch prominent |
| `D4` | 50 samples, **2 contexts**, YES 48 / NO 2 (96%)                          | **SUPPRESSED — G2**                      |
| `D5` | **12 samples**, 8 contexts, YES 12 / NO 0 (100%)                         | **SUPPRESSED — G1**                      |
| `D6` | 60 samples, 15 contexts, 96.7% dominance, **success 61%**                | **SUPPRESSED — G4**                      |
| `D7` | 50 samples, 10 contexts, 95% dominance, **coverage 60%**                 | **SUPPRESSED — G5**                      |
| `D8` | 50 samples spanning **two workflowVersions** (26 + 24)                   | **splits → both SUPPRESSED — G1**        |
| `D9` | 45 samples, 11 contexts, **YES 60% / NO 40%**, success 93%               | **SUPPRESSED — G3**                      |

`D8` is deliberately sized so the _combined_ 50 would clear G1 while each split half (26, 24)
does not. That is the only construction that demonstrates version splitting changed the
answer. Splitting by `workflowVersion` is **grouping, not gating** — the expectation is
explicitly _split into two groups, each suppressed by G1_.

`D9` is the honest negative: a decision that genuinely requires judgment. Without it, G3
never suppresses anything and graduates unproven.

`D4` and `D7` exist specifically to keep G2 and G5 honest. If someone "simplifies" the
grouping key or the denominators, those two go green for the wrong reason.

## Definition of Done — met

- [x] Aggregation implemented as pure functions.
- [x] All nine fixture groups produce a verdict.
- [x] Every negative fixture is correctly suppressed.
- [x] Every suppression names **every** gate that suppressed it.
- [x] Counterexamples are listed, not summarized away.
- [x] **A human read all nine verdicts and agreed with each one.**

That last checkbox was the actual gate. `spike/` is disposable; **the fixtures and pure
functions are not** — they graduate into `platform/analysis-engine` in Phase 5, and
`spike/` is deleted at the end of Phase 5.

### Recorded judgment call — do not re-open

`D3` passes all five gates and emits `CANDIDATE` even though all three minority selections
succeeded and four dominant ones failed. This was reviewed by a human and shipped as-is,
with no sixth gate. Reasoning: a gate built on three minority samples would fire on noise,
and the output already handles the case correctly — it recommends a default _with_ an escape
hatch and names that escape hatch via `minorityContextConcentration`. Do not re-open without
new evidence.

---

# PHASE 1 — FOUNDATION + INFRASTRUCTURE

**Status: COMPLETE.** Every Definition of Done item was re-verified on 2026-08-16 against a
live stack: `pnpm gates:full` green, `docker compose up --wait --build` reporting all three
services healthy, `db:migrate` in sync, `pnpm test:integration` 4/4, and `GET /health`
returning `200 {"status":"ok","checks":{"database":"up"}}` with the Dashboard rendering
"API up · Database up". Human approval gate passed. Carried debt below is non-blocking.

## Objective

A runnable, mechanically-bounded monorepo with a working engineering harness, before any
product code exists.

## Work packages

| #   | Package                  | Owner   | Acceptance                                                                 |
| --- | ------------------------ | ------- | -------------------------------------------------------------------------- |
| 1   | Repo + workspace + gates | Builder | `pnpm gates` exits 0; root commands run                                    |
| 2   | Boundary enforcement     | Builder | `check:boundaries` passes **and provably fails** on a deliberate violation |
| 3   | Engineering harness      | Builder | Four agents, handoff schema, hooks, skills — all exercised, not inspected  |
| 4   | Platform bootstrap       | Builder | API starts, Dashboard starts, Dashboard reaches API                        |
| 5   | Docker + integration     | Builder | `docker compose up` healthy; API reaches PostgreSQL                        |

## Validation commands

```bash
pnpm gates:full
pnpm check:boundaries
pnpm check:isolation
docker compose up --wait
pnpm --filter @lengentic/database db:migrate
pnpm test:integration
```

## Harness validation — required

Before Phase 2, validate the agent team with a **disposable** task: a temporary trivial API
endpoint and test.

```text
Builder → Validator → Reviewer → Gates
```

Introduce one intentional failure. Verify the full route:

```text
Failure → Evidence (schema-valid handoff) → Builder → Fix → Revalidation
```

Remove the disposable code afterward and run all gates again.

Design the seeded defect so the **existing tests stay green**. A defect the current suite
already catches proves the suite works, not that the routing works.

## Definition of Done

- [x] Repository structure exists.
- [x] pnpm workspace works.
- [x] Root commands work.
- [x] `.claude/` harness exists with four agents.
- [x] Agent responsibilities are defined.
- [x] Handoff JSON schema exists and is enforced by a hook.
- [x] Hooks work.
- [x] Initial Skills work.
- [x] Intentional failure-routing test succeeds.
- [x] NestJS API starts.
- [x] Next.js Dashboard starts.
- [x] Dashboard reaches API.
- [x] `pnpm check:boundaries` passes and provably fails on violation.
- [x] `pnpm check:isolation` passes.
- [x] `pnpm lint` passes.
- [x] `pnpm typecheck` passes.
- [x] `pnpm test` passes.
- [x] `pnpm build` passes.
- [x] PostgreSQL starts.
- [x] API reaches PostgreSQL.
- [x] `docker compose up` succeeds.

**Human approval gate.** Only then may Phase 2 begin.

## Carried debt — tracked, not blocking

Phase 1 completes against its original contract. These v3 changes land afterward:

```text
Handoffs are file-based (§10). The shipped hook parses subagent transcripts.
  → migrate to .artifacts/handoffs/<phase>-<task>-<role>.json
  → add fields: phase, taskId, role, summary, commandsRun
  → change Diagnostician trigger from LOW+FAILED to BLOCKED

No pre-commit hook exists, though gates:full is documented as the pre-commit tier.
No secret detection exists, though it is required before commit-ready.
```

---

# PHASE 2 — FIRST VERTICAL SLICE

## Objective

Prove the complete pipeline with the smallest possible telemetry model — **and settle the
ingestion contract**. Implement only `Run` and `Step`.

Idempotency, ID ownership, timestamp authority, and version tagging are cheap columns now
and expensive migrations in Phase 5.

## On `workflowVersion`

The single highest-value column in the schema, and it is one line. Aggregating decisions
across a prompt change produces a dominance figure computed over two different systems — a
number that is meaningless and looks authoritative, which is the worst combination.

Caller-supplied. Suggested values: a semver string, a git SHA, or a hash of the prompt set.
The Platform does not interpret it; it only groups by it. All historical aggregation is
scoped to `(workflowName, workflowVersion)` by default.

## Work packages

| #   | Package              | Owner   | Acceptance                                                      |
| --- | -------------------- | ------- | --------------------------------------------------------------- |
| 1   | Run + Step schema    | Builder | Migrations apply; Prisma types stay behind the persistence edge |
| 2   | Ingestion envelope   | Builder | §12 envelope, limits, merge rules, per-event results            |
| 3   | Idempotent upsert    | Builder | Same batch twice → identical row counts                         |
| 4   | Telemetry SDK v1     | Builder | Async, bounded, silent, flushable, bounded retry                |
| 5   | Runs API + Dashboard | Builder | Runs list, Run details, nested and orphaned Steps rendered      |

## Validation commands

```bash
pnpm gates
pnpm test:integration
pnpm --filter @lengentic/api test
```

## Required flow

```text
Standalone TypeScript client → Telemetry SDK → LenGentic API
  → PostgreSQL → Dashboard
```

## Definition of Done

A standalone TypeScript script can start a Run with a `workflowVersion`, create nested
Steps, complete the Run, send everything through the public SDK, `shutdown()`, and exit
cleanly. The Dashboard shows the resulting Run.

- [ ] Posting the same event batch twice produces no duplicates.
- [ ] Posting a child Step before its parent produces the correct tree.
- [ ] A completion event arriving before its start event produces one correct row.
- [ ] Conflicting terminal states resolve to `FAILED`, deterministically.
- [ ] Killing the script mid-run leaves a Run that derives as `STALE`.
- [ ] Running the script with the API down does not crash the script.
- [ ] A malformed event in a batch rejects only itself.
- [ ] No Playground code is involved.

**Human approval gate.**

---

# PHASE 3 — MINIMAL PLAYGROUND

## Objective

Create an independent reference consumer of LenGentic. Do not build the full multi-agent
system yet.

```text
Mock Agent → Telemetry SDK → LenGentic
```

## Mock Provider

```text
Requires no API key
Requires no network access
Deterministic output GIVEN A SEED
Configurable delays
Configurable failures
Predictable decisions
Configurable CONTEXT VARIATION      ← needed in Phase 6
```

Seeded determinism matters: Phase 6 needs runs that vary in context but not in outcome,
which requires controlled randomness rather than none. This is what §17's `Clock` and
`IdGenerator` abstractions exist to serve.

## Initial Mock Agent

```text
Start → Plan → Execute → Validate → Complete
```

No Planner/Researcher/Coder/Reviewer split yet.

## Execution-strategy evaluator

The orchestrator decides sequential vs parallel **deterministically, in the Playground**, and
emits the decision as ordinary telemetry (§13, §29). The Platform never makes this call and
never overrides it.

```text
Pure function          same inputs → same output, always
No LLM                 the verdict is a boolean expression, not a judgement
Sequential default     parallel is an exception that must be earned
Unknown is false       a condition nobody checked did not pass
Stable codes           every reason and blocker has a fixed code + readable text
Versioned              evaluatorVersion travels with the decision
```

Input — `awarenessContext`, schemaVersion 1:

```text
topology     taskCount  runnableTaskCount  dependencyCount  unresolvedDependencyCount
resources    claimedResourceCount  conflictingResourceCount  sharedMutableState
readiness    requirementsComplete  contractsStable  validationAvailable
             independentlyValidatable  independentlyReversible
limits       requestedConcurrency  availableConcurrency  effectiveConcurrency
risk         level  reasons[]
evaluation   eligible  reasons[]  blockers[]  evaluatorVersion
```

Every `readiness` field and `sharedMutableState` is `true | false | unknown`.
`resourceClaims` are **opaque strings**. Files, branches, worktrees, tables, queues and
accounts are all just claims; §4 keeps those concepts out of the Platform, and the evaluator
compares claims for equality without interpreting them.

Parallel is eligible only when **every** condition is explicitly true:

```text
 1  at least two meaningful runnable tasks
 2  task dependencies are known
 3  no unresolved dependency between tasks intended to run together
 4  resource claims do not conflict
 5  no unsafe shared mutable state
 6  requirements are sufficiently defined
 7  relevant contracts are stable
 8  required validation is available
 9  tasks can be validated independently
10  tasks can be reverted or failed independently
11  available concurrency is at least two
12  no risk policy requires serialisation
```

Output:

```text
mode                   sequential | parallel
eligible               true | false
reasons[]  blockers[]  stable code + readable description
requestedConcurrency   effectiveConcurrency
evaluatorVersion
```

Maximum concurrency is small and configurable. It is **never** derived from how many agents
happen to be available — capacity is not permission.

The harness solves the same problem for its own dispatch in `scripts/lanes.ts`, and that
implementation is a useful reference for the rule shapes. It is **not** a dependency: `.claude/`
and `scripts/` are engineering infrastructure, and §4 forbids the Playground importing either.

## Work packages

| #   | Package               | Owner   | Acceptance                                            |
| --- | --------------------- | ------- | ----------------------------------------------------- |
| 1   | Playground scaffold   | Builder | Consumes the public SDK entry only                    |
| 2   | MockProvider          | Builder | Seeded, offline, configurable delay/failure/context   |
| 3   | MockAgent + orchestr. | Builder | Five-step workflow emitting nested Steps              |
| 4   | Seeded Clock/IdGen    | Builder | Same seed → byte-identical telemetry                  |
| 5   | Strategy evaluator    | Builder | Deterministic verdict + `execution_strategy` Decision |
| 6   | CLI command           | Builder | `pnpm playground:happy-path`                          |

## Validation commands

```bash
pnpm playground:happy-path
pnpm check:isolation
pnpm check:boundaries
```

## Definition of Done

Running `pnpm playground:happy-path` creates a complete Run visible in LenGentic.

- [ ] The same seed produces byte-identical telemetry.
- [ ] `pnpm check:isolation` still passes.
- [ ] Playground imports `platform/telemetry-sdk` through its public entry only.
- [ ] Two eligible independent tasks produce `parallel`.
- [ ] One task produces `sequential`.
- [ ] An unresolved dependency produces `sequential`.
- [ ] Conflicting resource claims produce `sequential`.
- [ ] Shared mutable state produces `sequential`.
- [ ] Missing validation readiness produces `sequential`.
- [ ] Any required field set to `unknown` produces `sequential`.
- [ ] `availableConcurrency < 2` produces `sequential`.
- [ ] Identical inputs produce an identical decision, including reason and blocker order.
- [ ] Reason and blocker codes are asserted by code, never by display text.
- [ ] The decision reaches the Platform as an `execution_strategy` Decision and is retrievable.
- [ ] `rawContext` is redacted and size-capped per §15.
- [ ] The Platform exposes no path that invokes or alters Playground execution.

**Human approval gate.**
---

# PHASE 4 — RICH TELEMETRY + RUN EXPLORER

## Objective

Capture enough per-Run detail that a developer can reconstruct what an agent did, and expose
it. Decisions land here — they are the input the analysis engine consumes in Phase 5.

## Work packages

| #   | Package                    | Owner   | Acceptance                                                      |
| --- | -------------------------- | ------- | --------------------------------------------------------------- |
| 1   | Rich entities + migrations | Builder | Decision, ModelCall, ToolCall, Error persist per §13            |
| 2   | Payload safety             | Builder | §15 order enforced on **every** arbitrary JSON field            |
| 3   | SDK extensions             | Builder | `recordDecision` returns a handle exposing `decisionId`         |
| 4   | Standalone attestation     | Builder | `telemetry.attestOutcome(id, …)` works from a different process |
| 5   | Run Explorer               | Builder | Timeline, hierarchy, decisions, calls, errors, ingestion health |

## Run Explorer — required views

```text
Run Summary          (incl. workflowVersion)
Execution Timeline   (client clocks ONLY)
Step Hierarchy       (orphans flagged)
Decisions            (contextKey visible; strategy evidence per §29)
Model Calls
Tool Calls           (truncation flagged)
Errors
Ingestion Health     (dropped events, if any)
```

## Validation commands

```bash
pnpm gates
pnpm test:integration
pnpm --filter @lengentic/telemetry-sdk test
```

## Definition of Done

Opening a Run lets a developer reconstruct what the agent did, in what order, which
decisions occurred under which `contextKey`, which models and tools were called, where
failures occurred, and whether any telemetry was lost or truncated.

- [ ] A tool input containing a fake API key is redacted **before transmission**.
- [ ] A 1MB tool output is truncated and flagged.
- [ ] Circular data in `metadata` does not throw into host code.
- [ ] An attestation posted from a second process updates the original Decision.
- [ ] An attestation for an unknown `decisionId` is accepted and stored.
- [ ] Dropped-event count is visible in the Dashboard.

**Human approval gate.**

---

# PHASE 5 — ANALYSIS ENGINE

## Objective

Turn stored telemetry into evidence-backed recommendations — and, more importantly, decline
to produce bad ones.

**Write the negative fixtures before the positive path.** False positives are the failure
mode that kills a recommendations product.

## Work packages

| #   | Package                    | Owner   | Acceptance                                                                   |
| --- | -------------------------- | ------- | ---------------------------------------------------------------------------- |
| 1   | Package + types only       | Builder | `platform/analysis-engine` exists; `spike/types.ts` graduates. **No logic.** |
| 2   | Negative fixture suite     | Builder | Gate expectation grid transcribed as data; `D10` fails two gates at once     |
| 3   | Deterministic candidate    | Builder | §18 aggregation, §19 gates, §21 output shape                                 |
| 4   | Repeated failed action     | Builder | §20.2 conditions only; `R1`–`R4` fixtures pass, and `R4` emits               |
| 5   | Persistence + trigger + UI | Builder | Fingerprint dedupe, `POST /v1/analysis/run`, Dashboard rendering             |

Packages 1–4 are **5a** and run before Phase 2. Package 5 is **5b** and stays after Phase 4.
See the execution order amendment in Part III.

**Package 1 carries no aggregation and no gate code.** Graduating Phase 0's `aggregate.ts`
and `gates.ts` in package 1 would land the positive path before package 2's fixtures exist,
which is the exact inversion this phase's objective forbids. The logic graduates in
packages 3 and 4, against fixtures that are already red.

**Fixture provenance.** `spike/fixtures/decisions.json` supplies the `D1`–`D9` _input_ data
verbatim; Phase 0 already reconciled it with the tables in this document. Every _expected_
result is written fresh from the `D1`–`D9` table in Phase 0 and the `D4`–`D9` / `R1`–`R3`
table below — never from what `pnpm spike` printed. A fixture whose expectation was read off
the implementation cannot fail when the implementation is wrong. `R1`–`R3` are new here and
are built from scratch. `spike/` therefore survives 5a as an independent cross-check and is
deleted in 5b, per `p5.spike-deleted`.

## Negative fixture suite — required

```text
D4  Low context diversity      50 samples, 2 contexts, 96% dominance   → G2
D5  Insufficient sample        12 samples, 100% dominance              → G1
D6  Dominant and wrong         60 samples, 96.7% dominance, 61% success → G4
D7  Poor outcome coverage      50 samples, 95% dominance, 60% coverage → G5
D9  Genuine judgment call      45 samples, 60/40 split                 → G3
D8  Version boundary           50 samples, two workflowVersions        → splits, both G1
D10 Two gates at once          12 samples, 2 contexts                  → G1 AND G2
D11 Nothing attested           40 samples, every outcome UNKNOWN       → G5 fails, G4 is N-A

R1  Batch iteration            10 identical SUCCESSFUL actions         → silent
R2  Below threshold            2 consecutive failures, threshold 3     → silent
R3  Changing inputs            4 failures, different target each time  → silent (progress)
R4  Genuine repeated failure   3 consecutive failures, same target     → EMIT
```

Each negative fixture asserts both that no recommendation is emitted **and** which gate
suppressed it. `R3` is the important one: different targets means progress, not a loop.

## Gate expectation grid

This grid is the **only** legal source for a Phase 5a expected value. It was computed twice,
independently, from the raw inputs in `spike/fixtures/decisions.json` against the denominators
in §18 and the thresholds in §19, by two agents that were denied sight of `spike/aggregate.ts`,
`spike/gates.ts` and the fixture file's own `expect` blocks. Both grids agree cell for cell.
Evidence: `.artifacts/evidence/5a/gate-expectation-grid.md`.

`D8` splits on `workflowVersion` before gating, so it occupies two rows.

| Fixture      | samples | contexts | dominant | dominance | coverage | dominant success | G1   | G2   | G3   | G4   | G5   | Verdict    | failedGates | counterexamples |
| ------------ | ------- | -------- | -------- | --------- | -------- | ---------------- | ---- | ---- | ---- | ---- | ---- | ---------- | ----------- | --------------- |
| `D1`         | 50      | 12       | YES      | 98.00%    | 94.00%   | 95.65%           | PASS | PASS | PASS | PASS | PASS | CANDIDATE  | —           | 1               |
| `D2`         | 40      | 9        | SKIP     | 92.50%    | 90.00%   | 91.43%           | PASS | PASS | PASS | PASS | PASS | CANDIDATE  | —           | 3               |
| `D3`         | 50      | 10       | YES      | 94.00%    | 100.00%  | 91.49%           | PASS | PASS | PASS | PASS | PASS | CANDIDATE  | —           | 3               |
| `D4`         | 50      | 2        | YES      | 96.00%    | 96.00%   | 95.65%           | PASS | FAIL | PASS | PASS | PASS | SUPPRESSED | G2          | 2               |
| `D5`         | 12      | 8        | YES      | 100.00%   | 100.00%  | 100.00%          | FAIL | PASS | PASS | PASS | PASS | SUPPRESSED | G1          | 0               |
| `D6`         | 60      | 15       | YES      | 96.67%    | 93.33%   | 61.11%           | PASS | PASS | PASS | FAIL | PASS | SUPPRESSED | G4          | 2               |
| `D7`         | 50      | 10       | YES      | 96.00%    | 60.00%   | 96.55%           | PASS | PASS | PASS | PASS | FAIL | SUPPRESSED | G5          | 2               |
| `D8` a1b2c3d | 26      | 8        | YES      | 96.15%    | 100.00%  | 100.00%          | FAIL | PASS | PASS | PASS | PASS | SUPPRESSED | G1          | 1               |
| `D8` e4f5a6b | 24      | 8        | YES      | 95.83%    | 100.00%  | 100.00%          | FAIL | PASS | PASS | PASS | PASS | SUPPRESSED | G1          | 1               |
| `D9`         | 45      | 11       | YES      | 60.00%    | 95.56%   | 96.15%           | PASS | PASS | FAIL | PASS | PASS | SUPPRESSED | G3          | 18              |
| `D10`        | 12      | 2        | YES      | 100.00%   | 100.00%  | 100.00%          | FAIL | FAIL | PASS | PASS | PASS | SUPPRESSED | G1, G2      | 0               |
| `D11`        | 40      | 8        | YES      | 95.00%    | 0.00%    | _undefined_      | PASS | PASS | PASS | N-A  | FAIL | SUPPRESSED | G5          | 2               |

`D5` additionally excludes 20 stale-run rows and 5 null-`contextKey` rows before any of the
above is computed. Those 25 never reach `sampleCount`.

### Why `D10` and `D11` exist

Nine fixtures is not enough to verify the Definition of Done, and this is not a matter of
taste. `D1`–`D9` produce **exactly one failing gate on every suppressed row**. That is a
clean one-suppressor-per-gate design and it was the right Phase 0 target, but it leaves two
Definition of Done items with no fixture that can fail:

- _"Every suppression names **every** failing gate, not the first one to fire."_ With no row
  that fails twice, `failedGates = [firstFailure]` is indistinguishable from the correct
  implementation. **`D10`** is the discriminator: 12 samples across 2 contexts fails `G1` and
  `G2` together, and a short-circuiting implementation reports one of them.
- _"`attestedSuccessRate` is `null`, never `0`, when no outcomes are attested."_ Every
  `D1`–`D9` dominant option has a non-empty attested denominator, so the null path is never
  taken. **`D11`** takes it: every outcome is `UNKNOWN`, so `G5` fails on 0% coverage while
  `G4` reports `N-A` — never `FAIL`, never `0.0%`. This is §18's "G5 is evaluated first in
  that case" made testable.

`N-A` is not `PASS`. A group carrying an `N-A` cell is `SUPPRESSED`, and `G4` appears in the
report as `N-A` rather than in `failedGates`. Reporting an unmeasured rate as a failure
invents a finding out of missing data; reporting it as a pass is the lie §2 forbids.

### `R` fixtures — no gates apply

`G1`–`G5` are the deterministic-candidate analyzer's gates. §20.2 is a conditions analyzer:
it emits when all five of its own conditions hold and is otherwise silent. There is no gate
grid for `R1`–`R4`, and writing one would imply a suppression mechanism that does not exist.

| Fixture | Shape                                                          | Expected                      |
| ------- | -------------------------------------------------------------- | ----------------------------- |
| `R1`    | 10 identical actions, all SUCCESS                              | silent — no failure at all    |
| `R2`    | 2 consecutive failures, same target, threshold 3               | silent — below threshold      |
| `R3`    | 4 failures, a different `inputFingerprint` each time           | silent — progress, not a loop |
| `R4`    | 3 consecutive failures, same `toolName` and `inputFingerprint` | **EMIT** — one recommendation |

**`R4` is required, not optional.** `R1`, `R2` and `R3` all expect silence, so an
implementation of §20.2 that is literally `return []` passes all three and the analyzer
graduates into 5b unexercised. `D1`–`D3` already carry the positive path for the
deterministic analyzer; `R` had no equivalent until `R4`.

## The fixture wave lands green, and still lands before the positive path

### The problem this settles

Work package 2 exists to author expectations before the code that produces them. The obvious
way to do that — write the analyzer specs first and let them fail — cannot be reported. Every
lane closes with `.claude/rules/lane-handoff.schema.json`, `pnpm lanes handoff` refuses `DONE`
while any test failed (`scripts/lanes.ts`, _"DONE claimed while N test(s) failed"_), and the
schema has no `expected-red` status. `BLOCKED` would be a lie — nothing blocked the lane.

The property the phase objective actually protects is **not** that a suite is red. It is that
no expected value can be read off the implementation. A red suite is one way to get that
property. It is not the only way, and it is the one this repository's own contracts cannot
express.

### What package 2 lands instead

Three things, all green, none of which the analyzer packets may edit:

```text
fixtures/inputs/**          D1-D11 and R1-R4 input data
fixtures/expectations.ts    the grid above, transcribed as a typed table
test/grid/**                assertAgainstGrid() + its own meta-tests
```

`assertAgainstGrid(actual, expected)` is the whole assertion — sample counts, distinct
contexts, dominant option, all five gate cells, `failedGates` as a **set**, verdict,
counterexample count, and `attestedSuccessRate === null` where the grid says `N-A`. Package 2
proves it works without any analyzer, against hand-built objects: one conforming object that
must pass, and a deliberately wrong object per assertion — a `failedGates` list missing its
second entry, an `attestedSuccessRate` of `0` where `null` is required, an `N-A` counted as a
pass — each of which must throw. A comparator nobody mutation-checked is the green that lies
this whole phase is about.

Its meta-tests also assert the table itself is complete: every fixture present, every gate
cell populated, every `SUPPRESSED` row naming at least one gate, every `CANDIDATE` row naming
none, `R4` the only `R` row expecting an emission.

### What packages 3 and 4 land

```text
src/**                      the analyzer
test/analyzer/**            one spec each, feeding fixtures through assertAgainstGrid()
```

They supply `actual`. They do not own a single `expect` call about analyzer behaviour.

`fixtures/**` and `test/grid/**` are outside their `allowed_paths`, so an analyzer packet
**physically cannot** relax an expectation to make its own code pass. `pnpm lanes check`
enforces that on paths. Hash `fixtures/expectations.ts` and `test/grid/**` before and after
each analyzer packet and compare as well — paths are what the tool validates, and a hash is
what catches an edit that stayed inside a path it was allowed to touch.

The ordering guarantee survives intact: the numbers are committed, reviewed and merged before
any line of `src/**` exists.

## Validation commands

```bash
pnpm --filter @lengentic/analysis-engine test
pnpm gates
pnpm test:integration
```

## Definition of Done — 5a

Validated by `pnpm --filter @lengentic/analysis-engine test` and `pnpm gates`. No container,
no `pnpm test:integration` — nothing in 5a touches a database.

- [ ] Phase 0's pure functions and fixtures live in `platform/analysis-engine`.
- [ ] `platform/analysis-engine` imports nothing from `platform/api`, `platform/database`,
      `platform/dashboard` or `playground`, and `pnpm check:boundaries` proves it.
- [ ] All eleven `D` fixtures and four `R` fixtures pass.
- [ ] Every suppression names **every** failing gate, not the first one to fire — `D10`
      fails two gates and both are named.
- [ ] `R4` emits. An implementation of §20.2 that returns nothing fails the suite.
- [ ] `counterexamples` is present on every deterministic recommendation, empty or not.
- [ ] Counterexamples include dominant-option failures **and** minority-option successes.
- [ ] `minorityContextConcentration` is computed.
- [ ] `attestedSuccessRate` is `null`, never `0`, when no outcomes are attested.
- [ ] Each expected value traces to a table in this document, not to `pnpm spike` output.

**Human approval gate. Phase 2 begins only after it.**

## Definition of Done — 5b

Everything above still holds, plus:

- [ ] `minorityContextConcentration` is rendered.
- [ ] Re-analysis with the same fingerprint updates, never duplicates.
- [ ] A `DISMISSED` recommendation stays dismissed across re-analysis.
- [ ] `POST /v1/analysis/run` triggers analysis; nothing runs inline with ingestion.
- [ ] `attestedSuccessRate` renders `N/A`, never `0.0%`, when no outcomes are attested.
- [ ] `spike/` is deleted.

**Human approval gate.**

---

# PHASE 6 — REPRODUCIBLE PLAYGROUND SCENARIOS

## Objective

Controlled Product Agent behavior that reliably proves the analyzers work. Exactly three
scenarios. Negative coverage lives in Phase 5 fixtures — a false-positive case needs a JSON
group, not a full agent run.

## Scenario 1 — Happy Path

```text
Plan → Execute → Validate → Complete

Expected: no recommendation
```

## Scenario 2 — Repeated Failed Action

```text
Generate → Test → FAIL
Modify   → Test → FAIL
Modify   → Test → FAIL

Expected: REPEATED_FAILED_ACTION
```

Same target and same test command across repetitions — otherwise the input-similarity
condition correctly rejects it.

## Scenario 3 — Repeated Decision

Fifty identical contexts would correctly produce **nothing** under G2. The scenario must
generate genuine context variation.

```text
Decision:  run_tests_after_code_change
Selected:  YES (dominant)

>= 30 runs spanning >= 8 distinct contextKeys:
  post_edit_small_diff   post_edit_large_diff   post_refactor
  post_dependency_bump   post_config_change     post_test_only_change
  post_docs_change       post_revert

Include 1-2 minority selections with attested SUCCESS,
so the counterexample path is exercised.

Expected: DETERMINISTIC_CANDIDATE with a non-empty counterexamples list
```

Scenario 3 runs in **one process** emitting ≥30 runs with a single `shutdown()` drain — not
30 process spawns, which would be dominated by Node startup and flush intervals.

This is the demo that shows the product refusing to be fooled by its own test data, then
producing a recommendation that admits its own limits.

## Work packages

| #   | Package              | Owner   | Acceptance                                            |
| --- | -------------------- | ------- | ----------------------------------------------------- |
| 1   | Scenario 1           | Builder | Emits nothing                                         |
| 2   | Scenario 2           | Builder | Emits `REPEATED_FAILED_ACTION`                        |
| 3   | Scenario 3           | Builder | Clears G2; emits candidate with counterexamples       |
| 4   | Seed reproducibility | Builder | Same seed → identical telemetry across full scenarios |
| 5   | One real provider    | Builder | Optional; must not block MVP completion               |

```bash
pnpm playground:happy-path
pnpm playground:repeated-failure
pnpm playground:deterministic-decision
```

## Product agents

At most two lightweight Product Agents for the primary workflow:

```text
PlannerAgent
ExecutorAgent
```

One deterministic orchestrator and the MockProvider. **Do not build a full
Planner/Researcher/Coder/Reviewer product team in the MVP.**

Provider logic stays inside Playground. The Platform only receives normalized telemetry.
Multi-provider comparison is Post-MVP.

## Definition of Done

- [ ] All three scenarios reliably produce their expected Platform behavior.
- [ ] Scenario 3 passes G2 on context diversity.
- [ ] Scenario 3 produces at least one counterexample.
- [ ] Mock execution requires zero paid API calls.
- [ ] Scenarios are seed-reproducible.
- [ ] At least one optional real-provider Run can be inspected.

**Human approval gate.**

---

# PHASE 7 — PORTFOLIO POLISH

## Objective

Harden, document, and make the demo repeatable by someone who has never seen the project.
Phase 7 may harden or combine tests; it must not introduce the first meaningful tests for
earlier behavior.

## Work packages

| #   | Package          | Owner     | Acceptance                                      |
| --- | ---------------- | --------- | ----------------------------------------------- |
| 1   | Regression suite | Validator | §"Critical unit tests" all present and passing  |
| 2   | E2E suite        | Validator | E2E 1–4, including the silence case             |
| 3   | CI completion    | Builder   | Every step below green on a clean checkout      |
| 4   | Docker smoke     | Validator | Clean-clone → `docker compose up` → Run visible |
| 5   | README + demo    | Builder   | Leads with G2 and the prior-art comparison      |

## Critical unit tests

```text
Repeated-failed-action detection
Iteration-vs-repetition discrimination
Decision aggregation
Gate evaluation (each gate independently)
Counterexample extraction
minorityContextConcentration
Recommendation fingerprinting and dedupe
Recommendation status transitions
SDK buffer overflow and drop counting
SDK never-throw guarantee
Redaction and truncation
Ingestion merge rules (out-of-order, conflicting terminal states)
```

## End-to-end tests

```text
E2E 1  Playground → SDK → Platform → Database → Dashboard
E2E 2  Repeated-failure scenario → Analyzer → REPEATED_FAILED_ACTION
E2E 3  Repeated-decision scenario → Analysis → DETERMINISTIC_CANDIDATE + counterexamples
E2E 4  Batch iteration workload → Analyzer → NO recommendation
```

**E2E 4 is the one that proves the product has judgment.**

## CI

```text
Install → Lint → Typecheck → check:boundaries → check:isolation
  → unit → integration → E2E
  → build API, Dashboard, SDK, Playground
  → validate Docker builds
```

## Developer experience

```bash
git clone <repository>
cd <repository>
cp .env.example .env
pnpm install
docker compose up
pnpm playground:happy-path
```

A Run appears in the Dashboard.

## README requirements

- Leads with **G2 and the prior-art comparison** — that is the differentiator.
- States the epistemic position from §2 verbatim.
- Contains a **limits** section that names the absent demotion mechanism explicitly.
- Says "attested success rate" everywhere, never "measured".

## Definition of Done

- [ ] Full regression suite green.
- [ ] All four E2E tests green.
- [ ] CI green on a clean checkout.
- [ ] Docker smoke test passes from a clean clone.
- [ ] README complete, including the limits section.
- [ ] Demo runs end to end without manual repair.

**Human approval gate. This closes the MVP.**

---

# PART IV — SCOPE, DEMO, AND OPEN ITEMS

---

# 24. Final MVP Definition of Done

```text
Playground → Telemetry SDK → LenGentic API → PostgreSQL
  → Analysis Engine → Recommendation → Dashboard
```

- [ ] Independent Platform startup.
- [ ] Independent Playground.
- [ ] Engineering Harness separated from Product Agents.
- [ ] Mechanically enforced boundaries.
- [ ] Public TypeScript Telemetry SDK, async and non-throwing.
- [ ] Idempotent ingestion with a defined envelope.
- [ ] Version-scoped history.
- [ ] Runs, nested Steps, Decisions, Model Calls, Tool Calls, Errors.
- [ ] Payload redaction and size caps on every arbitrary JSON field.
- [ ] Run Explorer with Execution Timeline.
- [ ] Repeated-failed-action detection with iteration discrimination.
- [ ] Historical Decision Analysis.
- [ ] Deterministic Candidate Detection with five gates.
- [ ] Counterexample reporting.
- [ ] Recommendation lifecycle (`OPEN` / `DISMISSED`).
- [ ] Run Summary aggregation.
- [ ] Negative fixture suite passing.
- [ ] Deterministic Mock scenarios.
- [ ] Zero-cost local demo.
- [ ] Optional real-provider integration.
- [ ] Automated tests.
- [ ] CI.
- [ ] Docker setup.
- [ ] Project documentation.

---

# 25. Final Demo Story

```bash
docker compose up
pnpm playground:deterministic-decision
```

1. Open the Dashboard. Show multiple Runs.
2. Open a Run. Show Timeline, Steps, Decisions, Tool Calls, Model Calls.
3. Trigger analysis.
4. Open Decision History:

```text
Decision:           run_tests_after_code_change
Workflow:           demo-workflow @ a1b2c3d
Samples:            48
Distinct contexts:  9
YES:                47  (97.9%)
NO:                 1   (2.1%)
Attested success:   95.7%
```

5. Show the recommendation, counterexamples included.

6. **The closing move.** Run the batch-iteration workload. Show that LenGentic emits
   **nothing**. Then show a low-diversity decision group:

```text
Verdict: SUPPRESSED
Gates:   G2 context_diversity  (2 < 5)
```

A tool that produces recommendations is unremarkable. A tool that demonstrably declines to
produce bad ones is the thing worth showing.

---

# 26. Explicitly Out of Scope

```text
RAG                          Vector Database              Neo4j
Decision Graph               Automatic Prompt Rewriting   Automatic Agent Modification
Automatic Model Routing      Provider Benchmarking        Automatic Provider Switching
Latency Optimizer            Cost Optimizer               Excessive Tool Call Analyzer
OpenTelemetry Integration    Authentication               Multi-Tenancy
Billing                      Kubernetes                   Complex Cloud Infrastructure
Slack Integration            GitHub Integration           Jira Integration
Enterprise Features          LangChain / LangGraph        Any job runner or broker
Generic loop detection       Recommendation severity      Cross-session learning
Awareness Snapshot           Learned strategy switching   Platform→Playground control
Background analysis worker   Multi-provider comparison    Adaptive orchestration
```

OTel _integration_ is out of scope. OTel-shaped _identifiers_ are in scope (§11) — that is a
naming decision, not a dependency.

The last three lines are the ones §29 is most likely to be misread as authorising. It does
not. §29 delivers instrumentation and one deterministic decision; everything downstream of
that stays here until the evidence exists to move it.

---

# 27. Post-MVP Backlog

```text
Recommendation outcome tracking
  (did the user accept it? did the deterministic default hold?
   the honest way to validate the thesis at scale)

Shadow mode
  (run the deterministic default alongside the LLM decision and
   compare — the only real counterfactual)

Awareness Snapshot and sequential-vs-parallel comparison (§29 stage 2)
Orchestrator consumption of strategy recommendations (§29 stage 3)
Recommendation demotion on regression
Automatic background analysis on terminal Run
Context-conditional defaults (per-contextKey analyzer)
Latency Analysis            Cost Analysis              Tool Usage Analysis
Decision RAG                Decision Graph             Prompt Version Tracking
Model Comparison            Provider Benchmarking      Provider Routing Recommendations
Agent Behavior Regression Testing                      CI/CD Agent Quality Gates
OpenTelemetry Support       Cloud Deployment           Enterprise Integrations
```

The first two are listed first deliberately. They turn a hypothesis generator into a
measurement instrument.

Items discovered during implementation go in `BACKLOG.md` with their discovery context, not
here.

---

# 28. Instructions for Claude Code

Work on one phase at a time. Never automatically begin the next phase.

Do not redesign the approved MVP while implementing it. Anything valuable but unnecessary
for the current phase goes into `BACKLOG.md`.

---

# 29. Agentic System Awareness

> **Agentic System Awareness** is LenGentic's ability to construct a verified operational
> model of an agentic workflow — its topology, dependencies, resource constraints, execution
> state, cost, risk, and evidence — so it can eventually provide evidence-backed execution
> recommendations.

Read "eventually" as load-bearing. This section exists to stop the MVP from claiming the
capability while it is still collecting the evidence for it.

## The four things that get confused

Keeping these apart is the whole discipline of this section. Collapsing any two of them is
how an observability tool starts making promises it cannot keep.

```text
Deterministic eligibility    a rule the orchestrator evaluates now.
                             No history. No learning. Reproducible.

Observed execution strategy  what the orchestrator actually chose, recorded.
                             A fact about one run. Not advice.

Historical recommendation    a claim over many runs, gated by G1-G5.
                             Does not exist until the evidence does.

Automatic adaptation         execution changing without a human.
                             Post-MVP, opt-in, and not LenGentic's to trigger.
```

## Staged delivery

```text
STAGE 1 — this MVP
  Instrument → Store → Deterministic Decision

STAGE 2 — after real evidence accumulates
  Analyze → Awareness Snapshot → Recommend

STAGE 3 — Post-MVP
  Adapt execution automatically
```

### Stage 1 — what is actually built

```text
The Playground evaluates parallelism deterministically   PHASE 3
Sequential fallback whenever context is incomplete       PHASE 3
The decision is emitted as an ordinary Decision          §13
Its context is stored, capped and redacted               §15
Its outcome is attested through the existing path        §14
The Run Explorer shows the evidence                      PHASE 4
```

No new entity, no new event type, no new endpoint, no second analysis pipeline.

### Stage 2 — deliberately not built

An Awareness Snapshot would compare sequential against parallel on success rate, duration,
token usage, retries, rework, conflicts and validation failures, and return one of
`PARALLEL_RECOMMENDED`, `SEQUENTIAL_RECOMMENDED` or the equivalent of insufficient evidence —
which in this plan is already spelled `SUPPRESSED` (§19).

It is not built because the data to build it on does not exist yet, and a comparison over
zero parallel runs is not a cautious comparison, it is a fabricated one. Stage 1 is what
makes stage 2 possible later without a migration.

When it is built it goes through §18 and §19 unchanged — same group key, same five gates,
same `counterexamples` field, present and possibly empty, never omitted (§2).

### Stage 3 — the boundary that must hold

If an external orchestrator ever consumes these recommendations, it consumes them by asking.
LenGentic exposes evidence; it does not reach into a running system. §4 already forbids the
control path, and opt-in, guardrails, rollback and sequential fallback are the orchestrator's
obligations, not the Platform's.

## What this section does not license

The instrumentation is deliberately shaped to look like the foundation of something larger.
That makes the failure mode specific and worth naming: reading a recorded strategy as a
recommendation.

```text
Observed 40 sequential runs                 is NOT   "sequential is correct"
The evaluator returned eligible: false      is NOT   "parallel would have failed"
Parallel ran twice and both succeeded       is NOT   evidence — G1 needs 30
```

LenGentic observes chosen options and attested outcomes. It does not observe counterfactuals
(§2). A run that went sequential tells us nothing about the parallel run that never happened,
and no volume of stage-1 data changes that — which is exactly why stage 2 needs the gates
rather than more rows.

Until a historical recommendation exists, no surface may display a confidence score for a
strategy. Deterministic eligibility is not confidence; it is a rule that ran.

Prefer the simplest solution satisfying the current Definition of Done.

Every completed phase must leave the repository runnable.

Mechanical checks are tooling, not agents. Never ask an agent to verify what a script can
verify.

Recommendations are hypotheses with counterevidence, never assertions. Say "attested success
rate", never "measured success rate". Never claim a decision "does not require an LLM".
Every deterministic recommendation carries a `counterexamples` field — it may be empty, it is
never omitted.

When implementing analyzers, write the negative fixtures before the positive path.

---

# RESOLVED DECISIONS

All six were confirmed by a human on **2026-08-16**, as proposed. They are recorded here
rather than deleted: a decision whose reasoning is lost gets re-litigated, and the
alternative considered is the part that stops that.

Machine-readable in `scripts/oracle/graph.json`; `pnpm oracle unblock` no longer reports
any of them as a blocker.

### OD-1 — `STALE_RUN_THRESHOLD` value — **RESOLVED: 30 minutes**

No value was specified in v2 or the corrections document. It changes which runs enter
aggregation, so it was not a free choice. Confirmed at the proposed **30 minutes**, held as
configuration rather than a constant so a deployment with slower agents can raise it without
a code change.

### OD-2 — Ingestion limits — **RESOLVED: as proposed**

```text
Max events per batch        500
Max request body            5 MB
Max single event payload    64 KB after client-side capping
```

Proposed rather than inherited — v2 never specified them and the brief requires that they
exist. Confirmed unchanged. They are configuration; the SDK's own caps (§15) must stay at or
below the server's, or a client will build batches the server rejects wholesale.

### OD-3 — Conflicting terminal states — **RESOLVED: `FAILED` wins**

`COMPLETED` and `FAILED` for one `entityId` resolve to `FAILED`, not to last-write-wins by
`occurredAt`.

The accepted cost, stated plainly: a genuine retry-to-success recorded under **one**
`entityId` will read as failed. That is the correct trade because the alternative makes the
stored outcome depend on network arrival timing, which is not a property of the system under
observation. The escape hatch is modelling: a retry is a **new** entity, not a re-completion
of the old one. Callers that reuse one `entityId` across a retry are describing two events
as one, and no merge rule can recover what the caller collapsed.

### OD-4 — `Repeated Failed Action` target/operation — **RESOLVED: dropped**

The "same target / operation" condition is removed from §20.2. Detection relies on
`inputFingerprint` alone, which is already computed over sanitized, canonicalized input.

For most tools the target _is_ the input, so the condition was redundant; where it was not,
defining per-tool target extraction would have meant the Platform interpreting tool
semantics, which §14 explicitly refuses to do elsewhere. §20.2 above is updated.

### OD-5 — Handoff retrofit timing — **RESOLVED: start of Phase 2**

The file-based handoff contract (§10) lands as the first work of Phase 2, before any
ingestion code. It does not drift to Phase 7.

Rationale: Phase 2 is the first phase with real parallel agent dispatch, so it is the first
phase where transcript-parsed handoffs would actually cost something. Retrofitting the
contract after four phases have run on the old one means four phases of handoffs that cannot
be replayed.

### OD-6 — Pre-commit hook and secret detection — **RESOLVED: Phase 1 debt batch**

Both land with the Phase 1 carried-debt batch, alongside OD-5. `gates:full` is documented as
the pre-commit tier and nothing currently enforces it; secret detection is required before
commit-ready and is absent. Both are small, and both get more expensive after Phase 2 starts
writing telemetry payloads that may contain credential-shaped fixtures.
