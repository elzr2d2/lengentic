# LenGentic

## Agent Observability & Decision Intelligence Platform

### MVP Implementation Plan — v2

---

# 0. Changes From v1

Summary of what changed and why, so the delta is reviewable.

```text
ADDED    Phase 0 — Thesis Spike (disposable, precedes Phase 1)
ADDED    workflowVersion on Run
ADDED    Client-generated IDs + idempotent ingestion
ADDED    Client/server timestamp separation
ADDED    STALE run handling
ADDED    Span-shaped identifiers (traceId / spanId / parentSpanId)
ADDED    Async buffered SDK transport + redaction + size caps
ADDED    Caller-supplied contextKey (replaces implicit normalizedContext)
ADDED    Context-diversity gate on deterministic candidates
ADDED    Counterexample reporting on recommendations
ADDED    Recommendation lifecycle (status + fingerprint + dedupe)
ADDED    Negative fixture suite (false-positive coverage)
ADDED    Iteration-vs-retry discriminator
ADDED    AnalysisContext contract definition
ADDED    Analysis trigger definition

CHANGED  Decision.success → outcome + outcomeAttestedBy
CHANGED  Recommendation wording: "replace" → "default + escape hatch"
CHANGED  Scenario 3 must produce varied contexts, not repeated identical ones
CHANGED  Engineering harness: 8 agents → 4 core + 2 escalation

REMOVED  Watchdog agent (replaced by deterministic tooling)
```

---

# 1. Product Goal

LenGentic is a provider-agnostic platform for observing, storing, analyzing, and improving agentic AI systems.

The platform should answer four core questions:

```text
What happened?

Why did it happen?

Is this behavior repeating?

Can part of this probabilistic behavior become deterministic software?
```

The core product loop is:

```text
Observe
   ↓
Store
   ↓
Analyze
   ↓
Recommend
```

The MVP must:

* Run locally end-to-end.
* Require no paid external service.
* Support deterministic Mock Agent scenarios.
* Remain provider-agnostic.
* Keep development agents completely separate from product agents.
* Produce evidence-based recommendations.
* Report evidence *against* its own recommendations, not only for them.
* Demonstrate production-oriented software engineering practices.

---

# 2. Epistemic Position

This section constrains every claim the product makes.

LenGentic observes **chosen options and attested outcomes**. It does not observe counterfactuals.

Therefore:

```text
LenGentic can say:

  "This decision selected X in N of M observed executions,
   across K distinct contexts, with an attested success
   rate of S%. Here are the M-N cases that did not."

LenGentic must never say:

  "This decision does not require an LLM."
```

Every recommendation is a **hypothesis with attached evidence and counterevidence**, addressed to a human. The suggested action is always a deterministic default with an escape hatch, never unconditional replacement.

This is not a hedge. It is the difference between a tool an engineer trusts and one they mute after the third false positive.

---

# 3. Architecture Overview

The repository contains three separate systems.

```text
┌──────────────────────────────────┐
│      Engineering Harness         │
│                                  │
│       Claude Code Agents         │
│                                  │
│ Architect                        │
│ Builder                          │
│ Validator                        │
│ Reviewer                         │
│                                  │
│ (escalation only)                │
│ Diagnostician                    │
│ Reflector                        │
└────────────────┬─────────────────┘
                 │
                 │ builds
                 ▼
┌──────────────────────────────────┐
│        LenGentic Platform      │
│                                  │
│ Telemetry API                    │
│ PostgreSQL                       │
│ Analysis Engine                  │
│ Recommendations                  │
│ Dashboard                        │
│ Telemetry SDK                    │
└────────────────▲─────────────────┘
                 │
                 │ telemetry
                 │
┌────────────────┴─────────────────┐
│           Playground             │
│                                  │
│ Product/Test Agents              │
│ Providers                        │
│ Tools                            │
│ Scenarios                        │
└──────────────────────────────────┘
```

---

# 4. Hard Architecture Boundaries

## Allowed

```text
Playground
    ↓
Telemetry SDK
    ↓
Platform
```

## Forbidden

```text
Platform
    ↓
Playground
```

```text
Platform Runtime
    ↓
.claude/
```

```text
Playground Runtime
    ↓
Engineering Agents
```

The `.claude/` directory is development infrastructure only.

LenGentic must run correctly if `.claude/` is removed.

The Platform must run correctly if the entire Playground is removed.

**These are verified mechanically, not by review.** See Section 14.

---

# 5. Repository Structure

```text
/
├── .claude/
│   ├── agents/
│   ├── skills/
│   ├── hooks/
│   ├── rules/
│   └── settings.json
│
├── platform/
│   ├── api/
│   ├── dashboard/
│   ├── telemetry-sdk/
│   ├── analysis-engine/
│   ├── shared/
│   └── database/
│
├── playground/
│   ├── agents/
│   ├── providers/
│   ├── tools/
│   ├── workflows/
│   ├── scenarios/
│   └── fixtures/
│
├── spike/                    ← Phase 0 only, deleted after Phase 5
├── docker/
├── docs/
│
├── CLAUDE.md
├── MVP_PLAN.md
├── BACKLOG.md
├── README.md
├── docker-compose.yml
├── package.json
└── pnpm-workspace.yaml
```

---

# 6. Locked Technology Stack

These decisions should not be revisited during MVP implementation unless a blocking technical issue is demonstrated.

## Runtime

* Node.js LTS
* TypeScript

## Package Management

* pnpm
* pnpm workspaces

## Backend

* NestJS
* REST
* Zod for shared runtime schemas

## Frontend

* Next.js
* React
* TypeScript

## Database

* PostgreSQL
* Prisma ORM

## Testing

* Vitest where framework-independent
* Nest-supported testing utilities for backend modules
* Supertest for HTTP integration testing

## Infrastructure

* Docker
* Docker Compose

## Boundary Enforcement

* dependency-cruiser (or `eslint-plugin-boundaries`)

## CI

* GitHub Actions

---

# 7. MVP Scope Rules

The MVP contains exactly seven implementation phases, preceded by one disposable spike.

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

Do not create:

```text
Phase 3A
Phase 3B
Phase 4C
```

A phase may contain tasks, but must remain one delivery milestone.

---

# 8. Scope Management Rule

Whenever a useful idea appears:

```text
Is it required for the current phase Definition of Done?
```

If yes:

```text
Implement it.
```

If no:

```text
BACKLOG.md
```

Do not expand the current phase.

Do not automatically start the next phase.

---

# PHASE 0 — THESIS SPIKE

# 9. Phase 0 Objective

Validate or kill the core product thesis before building four phases of infrastructure to serve it.

The riskiest assumption in LenGentic is not "can we store telemetry." It is:

```text
Does decision aggregation produce recommendations
that a competent engineer agrees with?
```

That question needs no database, no API, no dashboard, and no agents. It needs a function and some fixtures.

**Time-box: one day.** If it runs long, that is itself a finding.

---

# 10. Phase 0 Scope

Create:

```text
spike/
├── fixtures/
│   └── decisions.json
├── aggregate.ts
└── report.ts
```

Constraints:

```text
No database
No HTTP
No NestJS
No UI
No agents
Pure functions only
```

Run with:

```bash
pnpm spike
```

Output goes to stdout as plain text.

---

# 11. Phase 0 Fixtures

Hand-write roughly 8 decision groups. Include failure cases deliberately.

## Positive candidates

```text
P1  50 samples, 12 distinct contexts,
    YES 49 / NO 1, attested success 96%
    → should recommend

P2  40 samples, 9 distinct contexts,
    SKIP 37 / RUN 3, attested success 92%
    → should recommend, with 3 counterexamples surfaced
```

## Negative candidates

```text
N1  50 samples, 2 distinct contexts, YES 48 / NO 2
    → must NOT recommend (dominance is an artifact of
      context uniformity, not decision triviality)

N2  12 samples, 8 distinct contexts, YES 12 / NO 0
    → must NOT recommend (insufficient sample)

N3  60 samples, 15 distinct contexts, YES 58 / NO 2,
    attested success 61%
    → must NOT recommend (the dominant option is
      dominant and also frequently wrong)

N4  50 samples spanning two workflowVersions
    → must split into two groups, neither qualifying

N5  50 samples, YES 47 / NO 3, success 95%,
    but all 3 NO cases succeeded and 4 YES cases failed
    → must recommend only with the minority branch
      surfaced prominently
```

---

# 12. Phase 0 Deliverable

A text report, one block per group:

```text
Decision:            run_tests_after_code_change
Workflow:            demo@v3
Samples:             50
Distinct contexts:   12
Distribution:        YES 49 (98.0%) | NO 1 (2.0%)
Attested success:    96.0%

Gates:
  sample_count       PASS  (50 >= 30)
  context_diversity  PASS  (12 >= 5)
  dominance          PASS  (98.0% >= 90.0%)
  outcome_success    PASS  (96.0% >= 90.0%)

Verdict:             CANDIDATE

Counterexamples:     1
  - run 8f2a…  context: post_refactor_large_diff
    selected NO, outcome SUCCESS
```

---

# 13. Phase 0 Definition of Done

* [ ] Aggregation implemented as pure functions.
* [ ] All 8 fixture groups produce a verdict.
* [ ] Every negative fixture is correctly suppressed.
* [ ] Every suppression names the gate that suppressed it.
* [ ] Counterexamples are listed, not summarized away.
* [ ] **You read all 8 verdicts and agree with each one.**

That last checkbox is the actual gate. If you disagree with any verdict, the thresholds or the gate set are wrong, and they get fixed here — where fixing them costs an hour instead of a migration.

`spike/` is disposable. The **fixtures and the pure functions are not** — they graduate into `platform/analysis-engine` and its test suite in Phase 5.

If the thesis does not survive this phase, stop and reconsider the product before writing Phase 1.

---

# PHASE 1 — FOUNDATION + INFRASTRUCTURE

# 14. Phase 1 Objective

Build:

1. The engineering harness that will build LenGentic.
2. The repository foundations.
3. The minimal Platform runtime infrastructure.
4. Mechanical enforcement of the architecture boundaries.

No product telemetry behavior is implemented yet.

---

# 15. Repository Bootstrap

## Tasks

* [ ] Initialize Git repository.
* [ ] Initialize pnpm workspace.
* [ ] Create root `package.json`.
* [ ] Create `pnpm-workspace.yaml`.
* [ ] Create shared TypeScript configuration.
* [ ] Configure ESLint.
* [ ] Configure Prettier.
* [ ] Add `.gitignore`.
* [ ] Add `.editorconfig`.
* [ ] Declare supported Node.js version.
* [ ] Create `.env.example`.
* [ ] Create `README.md`.
* [ ] Create `MVP_PLAN.md`.
* [ ] Create `BACKLOG.md`.
* [ ] Create `CLAUDE.md`.

---

# 16. Root Commands

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm format
pnpm typecheck
pnpm check:boundaries
pnpm check:isolation
pnpm gates
```

`pnpm gates` runs the full set. All relevant workspaces must be reachable through root scripts.

---

# 17. Mechanical Boundary Enforcement

v1 assigned boundary enforcement to an LLM agent. That contradicts the plan's own rule about preferring deterministic tooling for mechanical validation. Boundaries are now enforced by tooling.

## `pnpm check:boundaries`

dependency-cruiser rules:

```text
platform/**  must not import  playground/**
platform/**  must not import  .claude/**
playground/** must not import .claude/**
playground/** may import      platform/telemetry-sdk  (public entry only)
playground/** must not import platform/api/**
playground/** must not import platform/analysis-engine/**
```

Violations fail the build.

## `pnpm check:isolation`

A script that, in a temporary checkout:

```text
1. Delete playground/   → pnpm install && pnpm build && pnpm test
2. Delete .claude/      → pnpm install && pnpm build && pnpm test
3. Delete both          → pnpm install && pnpm build && pnpm test
```

Any failure fails the check. This runs in CI, not on every edit.

## Tasks

* [ ] Configure dependency-cruiser with the rules above.
* [ ] Write `check:isolation` script.
* [ ] Wire both into `pnpm gates`.
* [ ] Wire both into CI.
* [ ] Add a deliberate violation, confirm it fails, remove it.

---

# 18. Engineering Agent Harness

Engineering Agents build LenGentic. They are not LenGentic Product Agents.

v1 defined eight agents, five on Opus-high, before a single line of product code existed. That is the scope creep this plan is designed to prevent, applied to the plan's own tooling. Start with four.

Create:

```text
.claude/agents/
```

with:

```text
architect.md
builder.md
validator.md
reviewer.md
```

Create **only when a real failure demands them**:

```text
diagnostician.md
reflector.md
```

Record the triggering failure in `BACKLOG.md` when either is created. If neither is ever created, that is a valid outcome.

---

# 19. Architect Agent

## Recommended Model

```text
Opus
High reasoning
```

## Responsibilities

* System architecture.
* Complex interface design.
* Resolving ambiguity.
* Identifying architecture risk.
* Decomposing unusually complex work.

## Must Not

* Perform routine implementation.
* Expand MVP scope.
* Redesign accepted architecture without evidence.

---

# 20. Builder Agent

## Recommended Model

```text
Sonnet
High
```

## Responsibilities

* Primary implementation.
* Refactoring.
* Fixing validated defects.
* Writing migrations.
* Updating implementation documentation when required.

Builder is the primary code-writing agent.

---

# 21. Validator Agent

Merges v1's Runner and Tester. Their responsibilities were adjacent enough that the handoff cost exceeded the separation benefit.

## Recommended Model

```text
Opus
High
```

## Responsibilities

* Run applications, builds, tests, lint, typecheck.
* Capture runtime output.
* Behavioral validation.
* Edge-case design.
* Adversarial testing.
* Detect false-positive tests.
* Identify "green tests that prove nothing."
* Report validation evidence.

Validator reports failures.

Validator must not silently redesign or repair implementation.

---

# 22. Reviewer Agent

## Recommended Model

```text
Opus
High
```

## Responsibilities

* Code review.
* Architecture review.
* Maintainability review.
* Scope validation against the current Definition of Done.
* Detect unintended coupling that tooling cannot express.

Reviewer does **not** check forbidden imports or phase boundaries. Those are `pnpm check:boundaries`.

---

# 23. Diagnostician Agent (escalation only)

## Recommended Model

```text
Opus
High
```

Create only after a failure whose root cause the Validator could not localize.

## Responsibilities

* Root-cause analysis.
* Failure classification.
* Narrow reproduction.
* Suggest targeted repair strategy.

---

# 24. Reflector Agent (escalation only)

## Recommended Model

```text
Opus
High
```

Create only after the same class of engineering mistake recurs across milestones.

## Responsibilities

* Detect repeated engineering mistakes.
* Improve reusable project rules.
* Improve team workflow.

Reflector must not expand product scope.

---

# 25. Agent Handoff Contract

Validation agents return structured findings as **JSON**, so hooks can validate the shape.

```json
{
  "status": "FAILED",
  "owner": "builder",
  "failure": "API returns 500 when database is unavailable.",
  "evidence": [
    {
      "command": "pnpm test:integration",
      "location": "health.integration.test.ts",
      "expected": "503",
      "actual": "500"
    }
  ],
  "affectedArea": "platform/api",
  "recommendedNextAction": "Handle database-health failure explicitly.",
  "confidence": "HIGH"
}
```

Schema lives at `.claude/rules/handoff.schema.json`. A hook validates agent output against it.

Allowed `status`: `PASSED` | `FAILED` | `BLOCKED`
Allowed `owner`: `architect` | `builder` | `validator` | `reviewer`
Allowed `confidence`: `HIGH` | `MEDIUM` | `LOW`

`LOW` confidence with `FAILED` status is the trigger to consider creating the Diagnostician.

---

# 26. Engineering Loop

Default loop:

```text
FRAME
  ↓
PLAN
  ↓
DELEGATE
  ↓
BUILD
  ↓
VALIDATE
  ↓
REVIEW
  ↓
GATES  (deterministic)
  ↓
DONE
```

Optional escalation:

```text
Architecture uncertainty  →  Architect
Unclear failure           →  Diagnostician
Repeated mistake pattern  →  Reflector
```

---

# 27. Ownership Rule

Validation and implementation are separate responsibilities.

Preferred:

```text
Builder
   ↓
Validator
   ↓
Reviewer
   ↓
Failure Evidence
   ↓
Builder
```

Avoid:

```text
Reviewer finds issue
   ↓
Reviewer silently fixes own finding
```

---

# 28. Task Lifecycle

```text
TODO
IN_PROGRESS
BLOCKED
VALIDATION
DONE
```

Each implementation task requires:

* Objective.
* Acceptance Criteria.
* Owner.
* Validation requirements.
* Definition of Done.

Only one major implementation task should be active per Builder unless explicit parallelization is justified.

---

# 29. Required Claude Project Rules

`CLAUDE.md` must include:

```text
Follow MVP_PLAN.md.

Work on one phase at a time.

Never automatically begin the next MVP phase.

Do not redesign the approved MVP while implementing it.

Anything valuable but unnecessary for the current phase
goes into BACKLOG.md.

Prefer the simplest solution satisfying the current
Definition of Done.

Platform and Playground must remain independent.

Platform must never import Playground code.

.claude is engineering infrastructure only.

Engineering Agents must never become runtime dependencies.

Mechanical checks are tooling, not agents.
Never ask an agent to verify something a script can verify.

Validation Agents report evidence instead of silently
repairing implementation.

Recommendations are hypotheses with counterevidence,
never assertions.

Every completed phase must leave the repository runnable.
```

---

# 30. Initial Skills

Create only reusable skills required immediately.

```text
validate-phase
run-quality-gates
review-diff
update-backlog
```

`inspect-boundaries` is removed — that is `pnpm check:boundaries`.

Do not create speculative skills.

---

# 31. Hooks

Use deterministic hooks for deterministic checks.

## During Development

* Format changed files.
* Run focused lint checks where reasonable.

## Before Completion

* Typecheck.
* Build.
* Relevant tests.
* `check:boundaries`.
* Handoff schema validation.

## Before Commit-Ready State

* Full lint.
* Tests.
* Build.
* Secret detection.
* `check:boundaries`.
* `check:isolation`.

Avoid running the entire validation suite after every small edit.

---

# 32. Platform Bootstrap

Create:

```text
platform/api
platform/dashboard
platform/database
```

## API Tasks

* [ ] Scaffold NestJS API.
* [ ] Configure environment validation.
* [ ] Configure structured logging.
* [ ] Add global error handling.
* [ ] Add global request validation.
* [ ] Add `/health` endpoint.

## Database Tasks

* [ ] Create PostgreSQL container.
* [ ] Configure Prisma.
* [ ] Configure migrations.
* [ ] Add migration command.
* [ ] Add reset command.
* [ ] Add seed infrastructure.
* [ ] Add DB connectivity health check.

## Dashboard Tasks

* [ ] Scaffold Next.js application.
* [ ] Create base layout.
* [ ] Configure API base URL.
* [ ] Create minimal Platform status page.
* [ ] Verify Dashboard can reach API.

---

# 33. Docker Infrastructure

* [ ] API Dockerfile.
* [ ] Dashboard Dockerfile.
* [ ] PostgreSQL service.
* [ ] Docker network.
* [ ] Persistent database volume.
* [ ] Health checks.
* [ ] Service startup dependencies.
* [ ] Environment injection.

Required:

```bash
docker compose up
```

must start the Platform runtime.

---

# 34. Testing Foundation

* [ ] Unit test environment.
* [ ] Backend integration test environment.
* [ ] API test utilities.
* [ ] Test database strategy.
* [ ] E2E test foundation.
* [ ] Root test command.

---

# 35. Engineering Harness Validation

Before Phase 2, validate the agent team with a disposable task.

```text
Create a temporary trivial API endpoint and test.
```

Execution:

```text
Builder → Validator → Reviewer → Gates
```

Introduce one intentional failure. Verify:

```text
Failure
↓
Evidence (valid against handoff.schema.json)
↓
Builder
↓
Fix
↓
Revalidation
```

Remove disposable code afterward. Run all quality gates again.

---

# 36. Phase 1 Definition of Done

* [ ] Repository structure exists.
* [ ] pnpm workspace works.
* [ ] Root commands work.
* [ ] `.claude/` harness exists with four agents.
* [ ] Agent responsibilities are defined.
* [ ] Handoff JSON schema exists and is enforced by a hook.
* [ ] Hooks work.
* [ ] Initial Skills work.
* [ ] Intentional failure-routing test succeeds.
* [ ] NestJS API starts.
* [ ] Next.js Dashboard starts.
* [ ] PostgreSQL starts.
* [ ] Dashboard reaches API.
* [ ] API reaches PostgreSQL.
* [ ] `pnpm check:boundaries` passes and provably fails on violation.
* [ ] `pnpm check:isolation` passes.
* [ ] `pnpm lint` passes.
* [ ] `pnpm typecheck` passes.
* [ ] `pnpm test` passes.
* [ ] `pnpm build` passes.
* [ ] `docker compose up` succeeds.

Only then may Phase 2 begin.

---

# PHASE 2 — FIRST VERTICAL SLICE

# 37. Objective

Prove the complete LenGentic data pipeline with the smallest possible telemetry model — **and settle the ingestion contract**.

Implement only:

```text
Run
Step
```

The ingestion contract is settled here, not later. Idempotency, ID ownership, timestamp authority, and version tagging are cheap columns in Phase 2 and expensive migrations in Phase 5.

---

# 38. Identifier Model

LenGentic uses span-shaped identifiers. This is not an OpenTelemetry integration — OTel remains out of scope — but adopting the *shape* now makes future compatibility a mapping instead of a rewrite.

```text
Run   ≈ trace
Step  ≈ span
```

All IDs are **client-generated** (UUIDv7 preferred, for time-ordered indexes).

Client-generated IDs are what make ingestion idempotent. Without them, an SDK retry after a timeout creates a duplicate — and duplicates inflate exactly the counters the deterministic analyzer depends on.

---

# 39. Domain Model

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

Derived status (not stored):

```text
STALE = status == RUNNING
        AND now - lastEventAt > STALE_RUN_THRESHOLD
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
startedAt          client clock
completedAt        client clock
receivedAt         server clock
metadata
```

Steps support nesting.

---

# 40. On `workflowVersion`

This is the single highest-value column in the schema, and it is one line.

Aggregating decisions across a prompt change produces a dominance figure computed over two different systems. The number is meaningless and looks authoritative, which is the worst combination.

`workflowVersion` is caller-supplied. Suggested values: a semver string, a git SHA, or a hash of the prompt set. The Platform does not interpret it — it only groups by it.

All historical aggregation is scoped to `(workflowName, workflowVersion)` by default.

---

# 41. Ingestion Contract

## Endpoint

```text
POST /v1/telemetry/events
```

Accepts a **batch** of events. Single-event posts are a batch of one.

## Rules

```text
Idempotent
  Re-posting an event with a known id is a no-op
  (or a merge for completion events). Never a duplicate row.

Out-of-order tolerant
  A Step may arrive before its parent.
  parentStepId has no FK constraint.
  Hierarchy is resolved at read time.
  Orphaned steps are surfaced in the Run Explorer,
  not silently dropped.

Late-arrival tolerant
  Events for a COMPLETED run are accepted and update
  lastEventAt. They do not reopen the run.

Timestamp authority
  Client timestamps are authoritative for ordering
  and duration. Server receivedAt is stored separately
  and used only for staleness and debugging.
  Never mix the two in a single computed duration.
```

## Tasks

* [ ] Batch ingestion endpoint.
* [ ] Idempotent upsert keyed on client id.
* [ ] Reject malformed events individually, not the whole batch.
* [ ] Return per-event accept/reject status.
* [ ] Orphan resolution at read time.
* [ ] `STALE` derivation.
* [ ] Integration test: post the same batch twice, assert row counts unchanged.
* [ ] Integration test: post child before parent, assert correct tree.

---

# 42. Telemetry SDK

Create:

```text
platform/telemetry-sdk
```

The SDK must not depend on any AI provider.

## Non-Negotiable Transport Requirements

An observability SDK that blocks its host distorts the system it measures. A synchronous HTTP call per step boundary would make LenGentic's own latency a confound in LenGentic's own data.

```text
Asynchronous
  Events go to an in-memory queue. The calling code
  never awaits a network round trip.

Batched
  Flush on interval (default 1s) or buffer size
  (default 100 events), whichever comes first.

Bounded
  Buffer has a maximum size. On overflow, drop
  oldest events and increment a dropped counter.
  Never grow without limit.

Silent
  The SDK never throws into host code. Transport
  failures are logged to a configurable sink and
  counted. An agent must not crash because
  LenGentic is down.

Flushable
  await telemetry.shutdown() drains the queue.
  Required for short-lived processes and scripts.
```

## Example

```ts
const run = telemetry.startRun({
  workflow: "demo-workflow",
  workflowVersion: "a1b2c3d"
});

const step = run.startStep({
  agent: "demo-agent",
  name: "execute"
});

step.complete();

run.complete();

await telemetry.shutdown();
```

## Tasks

* [ ] Async buffered queue.
* [ ] Interval + size flush.
* [ ] Bounded buffer with drop counter.
* [ ] Never-throw guarantee (test with a dead endpoint).
* [ ] `shutdown()` drain.
* [ ] Configurable failure sink.

---

# 43. Phase 2 Tasks

* [ ] Implement Run schema.
* [ ] Implement Step schema.
* [ ] Implement migrations.
* [ ] Implement batch telemetry ingestion.
* [ ] Implement idempotent upsert.
* [ ] Implement minimal TypeScript SDK per Section 42.
* [ ] Persist Runs.
* [ ] Persist Steps.
* [ ] Implement Runs API.
* [ ] Implement Run Details API.
* [ ] Display Runs in Dashboard.
* [ ] Display nested Steps.
* [ ] Display orphaned Steps distinctly.

---

# 44. Required Flow

```text
Standalone TypeScript Client
          ↓
Telemetry SDK
          ↓
LenGentic API
          ↓
PostgreSQL
          ↓
Dashboard
```

---

# 45. Phase 2 Definition of Done

A standalone TypeScript script can:

1. Start a Run with a `workflowVersion`.
2. Create nested Steps.
3. Complete the Run.
4. Send everything through the public SDK.
5. `shutdown()` and exit cleanly.

The Dashboard shows the resulting Run.

Additionally:

* [ ] Posting the same event batch twice produces no duplicates.
* [ ] Killing the script mid-run leaves a Run that derives as `STALE`.
* [ ] Running the script with the API down does not crash the script.
* [ ] No Playground code is involved.

---

# PHASE 3 — MINIMAL PLAYGROUND

# 46. Objective

Create an independent reference consumer of LenGentic.

Do not build the full multi-agent system yet.

---

# 47. Playground Architecture

```text
Mock Agent
   ↓
Telemetry SDK
   ↓
LenGentic
```

Create:

```text
playground/agents
playground/providers
playground/tools
playground/workflows
playground/scenarios
```

---

# 48. Mock Provider

MockProvider must:

* Require no API key.
* Require no network access.
* Produce deterministic output **given a seed**.
* Support configurable delays.
* Support configurable failures.
* Support predictable decisions.
* Support **configurable context variation** (needed in Phase 6).

Seeded determinism matters: Phase 6 needs runs that vary in context but not in outcome, which requires controlled randomness rather than none.

---

# 49. Initial Mock Agent

Implement one Mock Agent.

```text
Start
Plan
Execute
Validate
Complete
```

No Planner/Researcher/Coder/Reviewer split yet.

---

# 50. Phase 3 Tasks

* [ ] Create Playground application.
* [ ] Consume public Telemetry SDK.
* [ ] Create MockProvider with seeded determinism.
* [ ] Create MockAgent.
* [ ] Create basic workflow orchestrator.
* [ ] Emit `workflowVersion` from Playground config.
* [ ] Generate a successful Run.
* [ ] Generate nested Steps.
* [ ] Add Playground CLI command.

```bash
pnpm playground:happy-path
```

---

# 51. Phase 3 Definition of Done

Running:

```bash
pnpm playground:happy-path
```

creates a complete Run visible in LenGentic.

* [ ] The same seed produces byte-identical telemetry.
* [ ] `pnpm check:isolation` still passes.

---

# PHASE 4 — RICH TELEMETRY + RUN EXPLORER

# 52. Objective

Turn LenGentic from a basic Run viewer into an Agent execution explorer.

Introduce:

```text
Decision
ModelCall
ToolCall
Error
```

---

# 53. Decision Entity

```text
id
runId
stepId

decisionType
contextKey            caller-supplied, required
contextKeyVersion     caller-supplied, required
rawContext            JSON, size-capped, redacted

availableOptions
selectedOption

outcome               SUCCESS | FAILURE | UNKNOWN
outcomeAttestedBy     CALLER | UNKNOWN
outcomeObservedAt

createdAt
```

Do not store hidden model chain-of-thought.

---

# 54. On `contextKey`

v1 grouped decisions by an implicit `normalizedContext`. That single undefined field carried the entire differentiator.

Normalization is the hardest problem in the product:

```text
Too coarse  →  distinct decisions merge  →  fake dominance
Too fine    →  sample size never reached →  no output
```

Resolution: **the caller owns normalization.** The instrumented system supplies `contextKey` — a short, stable string it computes itself. The Platform groups by it and does not attempt to infer it.

This is the honest design. The Platform does not know what makes two contexts equivalent in the caller's domain; the caller does.

Supporting requirements:

```text
rawContext is stored alongside the key
  → re-normalization is possible without losing history

contextKeyVersion is stored
  → a change in normalization strategy splits groups
    instead of silently corrupting them

Groups whose contextKeyVersion changed mid-history
  are split, exactly like workflowVersion
```

If a caller supplies no `contextKey`, the decision is stored but **excluded from aggregation**. Silent inclusion under a default key is how fake dominance gets manufactured.

---

# 55. On `outcome` and `outcomeAttestedBy`

v1's Decision had a boolean `success`. Where that value comes from was never stated.

It comes from the caller. The instrumented system asserts whether the decision worked out; LenGentic has no independent way to verify it. In the MVP, the Playground both generates decisions and grades them — it is marking its own homework.

That is acceptable, but it must be **visible**. `outcomeAttestedBy` records it, and the Dashboard and recommendation text both say "attested success rate," never "measured success rate."

---

# 56. ModelCall Entity

```text
id
runId
stepId

provider
model

latencyMs

inputTokens
outputTokens

status
metadata

createdAt
```

Token information is optional.

---

# 57. ToolCall Entity

```text
id
runId
stepId

toolName

input                 size-capped, redacted
output                size-capped, redacted
inputTruncated        boolean
outputTruncated       boolean
inputBytes
outputBytes

startedAt
completedAt
durationMs

success
error
```

---

# 58. Payload Safety

Tool inputs are where credentials leak. This is one SDK feature and one config block, and it is far cheaper now than after the first token lands in a database.

```text
Size cap
  Default 32KB per field. Exceeding it truncates
  and sets the *Truncated flag. Never silently
  store a 4MB blob.

Redaction hook
  redact?: (value: unknown, path: string) => unknown

  Runs client-side, before transmission. Ships with
  default patterns for common credential shapes
  (Authorization headers, keys matching /api[_-]?key/i,
  bearer tokens).

Opt-out
  captureToolIO: false disables input/output capture
  entirely while retaining timing and success data.
```

---

# 59. Error Entity

```text
id
runId
stepId

type
message
metadata

createdAt
```

---

# 60. SDK Extensions

```ts
step.recordDecision({
  decisionType: "run_tests_after_code_change",
  contextKey: "post_edit_small_diff",
  contextKeyVersion: "v1",
  rawContext: { filesChanged: 2, linesChanged: 14 },
  availableOptions: ["YES", "NO"],
  selectedOption: "YES"
});

step.recordModelCall(...)
step.recordToolCall(...)
step.recordError(...)

decision.attestOutcome("SUCCESS");
```

Outcome attestation is a separate call because outcomes are usually known later than decisions.

---

# 61. Run Explorer

Run Details must show:

```text
Run Summary          (incl. workflowVersion)

Execution Timeline   (client clocks only)

Step Hierarchy       (orphans flagged)

Decisions            (contextKey visible)

Model Calls

Tool Calls           (truncation flagged)

Errors

Ingestion Health     (dropped events, if any)
```

---

# 62. Phase 4 Tasks

* [ ] Add rich telemetry schemas.
* [ ] Create migrations.
* [ ] Extend SDK per Section 60.
* [ ] Implement size caps and redaction hook.
* [ ] Extend ingestion API.
* [ ] Extend Run Details API.
* [ ] Build execution timeline.
* [ ] Build Decision view.
* [ ] Build ModelCall view.
* [ ] Build ToolCall view.
* [ ] Build Error view.
* [ ] Surface dropped-event count.

---

# 63. Phase 4 Definition of Done

Opening a Run should allow a developer to reconstruct:

```text
What the Agent did
In what order
Which decisions occurred, under which contextKey
Which models were called
Which tools were called
Where failures occurred
Whether any telemetry was lost or truncated
```

* [ ] A tool input containing a fake API key is redacted before transmission.
* [ ] A 1MB tool output is truncated and flagged.

---

# PHASE 5 — ANALYSIS ENGINE

# 64. Objective

Make LenGentic more than a logging system.

The MVP contains exactly two analyzers:

```text
Retry / Loop Detection
Deterministic Candidate Detection
```

No additional analyzer enters the MVP.

**Both analyzers are built test-first against the Phase 0 fixtures plus the negative suite in Section 72.** False positives are the failure mode that kills a recommendations product; they get covered before the happy path does.

---

# 65. Analyzer Contract

```ts
interface Analyzer {
  readonly id: string;
  analyze(context: AnalysisContext): Promise<Recommendation[]>;
}

interface AnalysisContext {
  /** The run that triggered analysis. */
  run: RunSnapshot;

  /** Read-only scoped access to prior runs. */
  history: HistoryQuery;

  /** Analyzer-specific thresholds, fully configurable. */
  config: AnalyzerConfig;

  now: Date;
}

interface HistoryQuery {
  /**
   * Scoped to the triggering run's
   * (workflowName, workflowVersion) by default.
   * STALE runs are always excluded.
   */
  decisionGroups(filter?: DecisionGroupFilter): Promise<DecisionGroup[]>;
  runs(filter?: RunFilter): Promise<RunSnapshot[]>;
}
```

Analysis Engine belongs to Platform.

It must not require an LLM.

Analyzers must not write to the database directly — they return `Recommendation[]` and the engine persists.

---

# 66. Analysis Trigger

v1 never said when analysis runs. It runs:

```text
On run terminal state (COMPLETED | FAILED)
  → enqueued as a background job, not inline
    with ingestion

On demand
  → POST /v1/analysis/run
```

Never per-event. Never synchronously in the ingestion path.

---

# 67. Recommendation Entity

```text
id
fingerprint           stable dedupe key

workflowName
workflowVersion
runId                 nullable (historical recs
                      span runs)

category
severity

title
description
suggestedAction

evidence              JSON
counterexamples       JSON, may be empty but the
                      field is never omitted

status                OPEN | ACKNOWLEDGED |
                      ACCEPTED | DISMISSED
statusChangedAt

firstSeenAt
lastSeenAt
```

Categories:

```text
RETRY_LOOP
DETERMINISTIC_CANDIDATE
```

Severity:

```text
INFO
LOW
MEDIUM
HIGH
```

## Lifecycle

Without dedupe, every analysis run regenerates the same recommendations forever and the dashboard becomes noise within a day.

```text
fingerprint = hash(category, workflowName,
                   workflowVersion, decisionType|sequenceKey)

On re-analysis:
  existing fingerprint  → update evidence + lastSeenAt
  new fingerprint       → insert as OPEN

DISMISSED recommendations are not resurfaced unless
evidence materially changes (configurable).
```

---

# 68. Retry / Loop Detection

Detect repeated execution sequences that indicate an agent is stuck.

## The Discriminator

v1's rule — "detect repeated execution sequences" — flags every batch loop. An agent processing ten items produces ten identical sequences and is working perfectly.

A repetition is a **retry** only if all three hold:

```text
1. The sequence repeats >= repetitionThreshold  (default 3)

2. Each repetition terminates in FAILED status
   or records an Error

3. Inputs are substantially unchanged between
   repetitions (compare tool input fingerprints
   and step attributes)
```

Otherwise classify as `ITERATION` and emit nothing.

## Example — retry (emits)

```text
Edit → Test → Fail
Edit → Test → Fail
Edit → Test → Fail

Same target file, same test command.
```

```text
Potential retry loop detected.

Sequence:  edit → test → fail
Repeated:  3 times
Unchanged: target file, test command
```

## Example — iteration (silent)

```text
Fetch → Parse → Store   (item 1, success)
Fetch → Parse → Store   (item 2, success)
Fetch → Parse → Store   (item 3, success)
```

Different inputs, no failures. Not a retry.

## Tasks

* [ ] Normalize comparable Steps.
* [ ] Detect repeated sequences.
* [ ] Implement failure-termination condition.
* [ ] Implement input-similarity condition.
* [ ] Configure repetition threshold.
* [ ] Produce structured evidence.
* [ ] Generate Recommendation.

---

# 69. Deterministic Candidate Detection

The primary MVP differentiator.

Goal: identify LLM-driven decisions where historical evidence suggests a deterministic default would be safe — **and surface the evidence against that suggestion in the same breath.**

---

# 70. Decision Aggregation

Group historical decisions by:

```text
workflowName
workflowVersion
decisionType
contextKey
contextKeyVersion
```

Calculate:

```text
sampleCount
distinctContextCount
optionDistribution
dominantOption
dominancePercentage
attestedSuccessRate
minorityBranch          the non-dominant selections
                        and their attested outcomes
```

Exclusions:

```text
STALE runs
Decisions with no contextKey
Decisions with outcome UNKNOWN
  (counted separately, reported as coverage)
```

---

# 71. Safety Gates

All gates must pass. Every threshold is configurable. Every failed gate is reported by name.

```text
G1  sampleCount >= minSampleCount
    default 30

G2  distinctContextCount >= minDistinctContexts
    default 5

G3  dominancePercentage >= dominanceThreshold
    default 90%

G4  attestedSuccessRate >= successThreshold
    default 90%

G5  outcomeCoverage >= coverageThreshold
    default 80%
    (fraction of decisions with a non-UNKNOWN outcome)
```

## Why G2 exists

This is the gate v1 was missing, and it is the one that matters most.

If fifty samples all share one `contextKey`, 98% dominance says nothing about whether the decision is trivial. It says the agent kept encountering the same situation. Dominance under context uniformity is an artifact of the sample, not a property of the decision.

G2 turns "this option wins" into "this option wins **across varied situations**," which is the only version of the claim that supports a deterministic default.

## What no gate can fix

None of these gates produce a counterfactual. LenGentic never observes what would have happened had the minority option been chosen. That is why the minority branch is reported rather than averaged away, and why the suggested action is a default with an escape hatch rather than a replacement.

---

# 72. Negative Fixture Suite — Required

False-positive coverage is a Phase 5 deliverable, not a Phase 7 nice-to-have. These are JSON fixtures against pure functions; no Playground run is required.

```text
N1  Low context diversity
    50 samples, 2 distinct contexts, 96% dominance
    → suppressed by G2

N2  Insufficient sample
    12 samples, 100% dominance
    → suppressed by G1

N3  Dominant and wrong
    60 samples, 97% dominance, 61% success
    → suppressed by G4

N4  Poor outcome coverage
    50 samples, 95% dominance, 40% outcomes UNKNOWN
    → suppressed by G5

N5  Version boundary
    50 samples spanning two workflowVersions
    → split into two groups, neither qualifies

N6  Batch iteration
    10 identical successful sequences
    → not a RETRY_LOOP

N7  Below retry threshold
    2 failed repetitions, threshold 3
    → not a RETRY_LOOP

N8  Changing inputs
    4 failed repetitions, different target each time
    → not a RETRY_LOOP (progress, not a loop)
```

Each negative fixture asserts both that no recommendation is emitted **and** which gate suppressed it.

---

# 73. Recommendation Output

## Deterministic candidate — required shape

```text
Category:  DETERMINISTIC_CANDIDATE
Severity:  MEDIUM

Deterministic default candidate:
run_tests_after_code_change

Workflow:            demo-workflow @ a1b2c3d
Samples:             50
Distinct contexts:   12
Distribution:        YES 49 (98.0%) | NO 1 (2.0%)
Attested success:    96.0%  (caller-attested)
Outcome coverage:    94.0%

Suggested action:
Consider a deterministic default of YES for this
decision, with an explicit escape hatch for the
conditions below. This would remove a model call
from the hot path while preserving the branch.

Counterexamples (1):
  - run 8f2a…
    contextKey: post_refactor_large_diff
    selected:   NO
    outcome:    SUCCESS

Note:
LenGentic observes chosen options only. It cannot
determine what would have happened had the minority
option been selected. Review the counterexamples
before removing the branch.
```

The `Note` block is not boilerplate. It is the difference between a recommendation and an overclaim.

---

# 74. Deterministic Analyzer Tasks

* [ ] Graduate Phase 0 pure functions into `analysis-engine`.
* [ ] Graduate Phase 0 fixtures into the test suite.
* [ ] Implement grouping per Section 70.
* [ ] Implement exclusions (STALE, no contextKey, UNKNOWN).
* [ ] Calculate option distributions.
* [ ] Calculate dominance.
* [ ] Calculate attested success rate.
* [ ] Calculate distinct context count.
* [ ] Calculate outcome coverage.
* [ ] Implement gates G1–G5, each individually configurable.
* [ ] Report suppressing gate by name.
* [ ] Extract minority branch as counterexamples.
* [ ] Generate Recommendation per Section 73.
* [ ] Implement fingerprint + dedupe.
* [ ] Implement status transitions.
* [ ] Display historical evidence in Dashboard.
* [ ] Display counterexamples in Dashboard, not collapsed by default.

---

# 75. Phase 5 Definition of Done

LenGentic produces evidence-based recommendations from stored telemetry without using an LLM.

* [ ] `RETRY_LOOP` works end-to-end.
* [ ] `DETERMINISTIC_CANDIDATE` works end-to-end.
* [ ] All eight negative fixtures are correctly suppressed.
* [ ] Each suppression names its gate.
* [ ] Re-running analysis twice does not duplicate recommendations.
* [ ] A dismissed recommendation stays dismissed.
* [ ] Every deterministic recommendation includes a counterexamples field.
* [ ] `spike/` is deleted.

---

# PHASE 6 — REPRODUCIBLE PLAYGROUND SCENARIOS

# 76. Objective

Create controlled Product Agent behavior that reliably proves the analyzers work.

The MVP contains exactly three scenarios.

Negative coverage lives in Phase 5 fixtures, not here — a false-positive case does not need a full agent run to test, only a JSON group.

---

# 77. Scenario 1 — Happy Path

```text
Plan → Execute → Validate → Complete
```

Expected:

```text
No critical recommendation.
```

---

# 78. Scenario 2 — Retry Loop

```text
Generate → Test → Fail
Modify   → Test → Fail
Modify   → Test → Fail
```

Same target, same test command across repetitions — otherwise the input-similarity condition correctly rejects it.

Expected:

```text
RETRY_LOOP
```

---

# 79. Scenario 3 — Repeated Decision

v1 said "repeat until minimum historical sample threshold is reached." Under G2 that scenario now correctly produces **nothing** — fifty identical contexts is exactly the artifact the diversity gate exists to suppress.

The scenario must therefore generate genuine context variation:

```text
Decision:     run_tests_after_code_change
Selected:     YES (dominant)

Across >= 30 runs spanning >= 8 distinct contextKeys:
  post_edit_small_diff
  post_edit_large_diff
  post_refactor
  post_dependency_bump
  post_config_change
  post_test_only_change
  post_docs_change
  post_revert

Include 1-2 minority selections with attested SUCCESS,
so the counterexample path is exercised.
```

Expected:

```text
DETERMINISTIC_CANDIDATE
with a non-empty counterexamples list
```

This is a better demo than v1's. It shows the product refusing to be fooled by its own test data, and then producing a recommendation that admits its own limits.

---

# 80. Scenario Commands

```bash
pnpm playground:happy-path
pnpm playground:retry-loop
pnpm playground:deterministic-decision
```

---

# 81. One Real Provider

Only after all Mock scenarios work.

```ts
interface AgentProvider {
  execute(request: AgentRequest): Promise<AgentResponse>;
}
```

Implement:

```text
MockProvider
OneRealProvider
```

The exact real provider may be chosen based on available credentials. Only one is required for MVP.

Provider logic remains inside Playground. Platform only receives normalized telemetry.

---

# 82. Product Agent Expansion

The full multi-agent software-development workflow is optional for MVP completion.

If implemented without expanding scope:

```text
PlannerAgent
ResearchAgent
CodingAgent
CodeReviewAgent
```

The three reproducible Mock scenarios remain the primary validation mechanism.

---

# 83. Phase 6 Definition of Done

* [ ] All three scenarios reliably produce their expected Platform behavior.
* [ ] Scenario 3 passes G2 on context diversity.
* [ ] Scenario 3 produces at least one counterexample.
* [ ] Mock execution requires zero paid API calls.
* [ ] Scenarios are seed-reproducible.
* [ ] At least one optional real-provider Run can be inspected.

---

# PHASE 7 — PORTFOLIO POLISH

# 84. Objective

Turn the working MVP into a professional portfolio project.

No major product capability may be introduced during this phase.

---

# 85. Critical Unit Tests

```text
Retry detection
Iteration-vs-retry discrimination
Decision aggregation
Gate evaluation (each gate independently)
Counterexample extraction
Recommendation fingerprinting and dedupe
Recommendation status transitions
SDK buffer overflow and drop counting
SDK never-throw guarantee
Redaction
```

---

# 86. Integration Tests

```text
Telemetry SDK → API → PostgreSQL
```

Verify:

* Event persistence.
* Idempotent re-ingestion.
* Out-of-order arrival.
* Run reconstruction.
* Historical aggregation.
* Version-scoped grouping.

---

# 87. End-to-End Tests

## E2E 1

```text
Playground → SDK → Platform → Database → Dashboard
```

## E2E 2

```text
Retry Scenario → Analyzer → RETRY_LOOP
```

## E2E 3

```text
Repeated Decision Scenario
   → Historical Analysis
   → DETERMINISTIC_CANDIDATE (with counterexamples)
```

## E2E 4

```text
Batch iteration workload → Analyzer → no recommendation
```

E2E 4 is the one that proves the product has judgment.

---

# 88. CI

GitHub Actions must:

* [ ] Install dependencies.
* [ ] Lint.
* [ ] Typecheck.
* [ ] `check:boundaries`.
* [ ] `check:isolation`.
* [ ] Run unit tests.
* [ ] Run integration tests.
* [ ] Run E2E tests.
* [ ] Build API.
* [ ] Build Dashboard.
* [ ] Build Telemetry SDK.
* [ ] Build Playground.
* [ ] Validate Docker builds.

---

# 89. Developer Experience

```bash
git clone <repository>
cd <repository>

cp .env.example .env

pnpm install

docker compose up
```

Then:

```bash
pnpm playground:happy-path
```

A Run should appear in the Dashboard.

---

# 90. README

## Problem

Explain why Agent execution becomes difficult to understand as workflows gain:

```text
Decisions
Tools
Retries
Model Calls
Failures
```

## Core Idea

```text
Observe → Store → Analyze → Recommend
```

## Architecture

Show separation between Engineering Harness, Platform, and Playground.

## Quick Start

Local setup.

## Run Explorer

One complete Run.

## Analysis Engine

Explain both analyzers.

## Deterministic Candidate Detection

The main differentiator — including the gates and **why G2 exists**. The reasoning about context diversity and counterfactuals is the most interesting engineering content in the project. Lead with it rather than burying it.

## What LenGentic Cannot Tell You

A short, honest section on the limits of observational data. This will read as more competent than a longer feature list.

## Playground

Reproducible scenarios.

## Roadmap

Clearly separate Post-MVP ideas.

---

# 91. Final Demo Story

## Step 1

```bash
docker compose up
```

## Step 2

```bash
pnpm playground:deterministic-decision
```

## Step 3

Open Dashboard. Show multiple Runs.

## Step 4

Open a Run. Show Timeline, Steps, Decisions, Tool Calls, Model Calls.

## Step 5

Open Decision History.

```text
Decision:           run_tests_after_code_change
Workflow:           demo-workflow @ a1b2c3d
Samples:            48
Distinct contexts:  9
YES:                47  (97.9%)
NO:                 1   (2.1%)
Attested success:   95.7%
```

## Step 6

Show the recommendation, counterexamples included.

## Step 7 — the closing move

Run the batch-iteration workload. Show that LenGentic emits **nothing**.

Then show a low-diversity decision group and the report line:

```text
Verdict: SUPPRESSED
Gate:    context_diversity  (2 < 5)
```

A tool that produces recommendations is unremarkable. A tool that demonstrably declines to produce bad ones is the thing worth showing.

---

# 92. Final MVP Definition of Done

```text
Playground → Telemetry SDK → LenGentic API
  → PostgreSQL → Analysis Engine → Recommendation
  → Dashboard
```

* [ ] Independent Platform startup.
* [ ] Independent Playground.
* [ ] Engineering Harness separated from Product Agents.
* [ ] Mechanically enforced boundaries.
* [ ] Public TypeScript Telemetry SDK, async and non-throwing.
* [ ] Idempotent ingestion.
* [ ] Version-scoped history.
* [ ] Runs, nested Steps, Decisions, Model Calls, Tool Calls, Errors.
* [ ] Payload redaction and size caps.
* [ ] Run Explorer with Execution Timeline.
* [ ] Retry / Loop Detection with iteration discrimination.
* [ ] Historical Decision Analysis.
* [ ] Deterministic Candidate Detection with five gates.
* [ ] Counterexample reporting.
* [ ] Recommendation lifecycle.
* [ ] Negative fixture suite passing.
* [ ] Deterministic Mock scenarios.
* [ ] Zero-cost local demo.
* [ ] Optional real-provider integration.
* [ ] Automated tests.
* [ ] CI.
* [ ] Docker setup.
* [ ] Project documentation.

---

# 93. Explicitly Out of Scope

```text
RAG
Vector Database
Neo4j
Decision Graph
Automatic Prompt Rewriting
Automatic Agent Modification
Automatic Model Routing
Provider Benchmarking
Automatic Provider Switching
Latency Optimizer
Cost Optimizer
Excessive Tool Call Analyzer
OpenTelemetry Integration
Authentication
Multi-Tenancy
Billing
Kubernetes
Complex Cloud Infrastructure
Slack Integration
GitHub Integration
Jira Integration
Enterprise Features
```

Note: OTel *integration* is out of scope. OTel-shaped *identifiers* are in scope (Section 38) — that is a naming decision, not a dependency.

---

# 94. Post-MVP Backlog

```text
Recommendation outcome tracking
  (did the user accept it? did the deterministic
   default hold? this is the honest way to validate
   the thesis at scale)

Shadow mode
  (run the deterministic default alongside the LLM
   decision and compare — the only real counterfactual)

Latency Analysis
Cost Analysis
Tool Usage Analysis
Decision RAG
Decision Graph
Prompt Version Tracking
Model Comparison
Provider Benchmarking
Provider Routing Recommendations
Agent Behavior Regression Testing
CI/CD Agent Quality Gates
OpenTelemetry Support
Cloud Deployment
Enterprise Integrations
```

The first two are listed first deliberately. They are the natural v2 and they are what turns a hypothesis generator into a measurement instrument.

---

# 95. Future Engineering Harness Integration

The Claude Code Engineering Agents are not a LenGentic runtime dependency.

Post-MVP they may become a real-world telemetry source:

```text
Claude Code Engineering Team
            ↓
      Telemetry Adapter
            ↓
        LenGentic
```

Potential observations:

```text
Builder retry patterns
Reviewer rejection patterns
Repeated tool usage
Repeated architecture decisions
Deterministic decision candidates
Agent workflow regressions
```

Explicitly Post-MVP.

---

# 96. Instructions for Claude Code

```text
Read the full MVP_PLAN.md first.

Complete Phase 0 before Phase 1. Do not skip it —
it exists to kill the project cheaply if the thesis
does not hold.

Preserve the seven-phase structure.

Work on the current phase only.

Split the current phase into executable tasks.

Do not start another phase automatically.

Do not introduce architecture that is not required by
the current Definition of Done.

Use the Engineering Agent Harness defined in Phase 1.
Do not create the escalation agents pre-emptively.

Use Builder as the primary implementation owner.

Validation agents return evidence as JSON matching
handoff.schema.json.

Never assign an agent a task a script can perform.

Send non-essential discoveries to BACKLOG.md.

Keep the repository runnable at every completed phase.

When implementing analyzers, write the negative
fixtures before the positive path.
```

---

# Implementation Order

```text
PHASE 0   Thesis Spike
             ↓
PHASE 1   Foundation + Infrastructure
             ↓
PHASE 2   First Vertical Slice
             ↓
PHASE 3   Minimal Playground
             ↓
PHASE 4   Rich Telemetry + Run Explorer
             ↓
PHASE 5   Analysis Engine
             ↓
PHASE 6   Reproducible Scenarios
             ↓
PHASE 7   Portfolio Polish
```

---

# Product Statement

**LenGentic observes how agents behave, learns from their historical decisions, and identifies where probabilistic behavior can become reliable software — while showing its work, including the evidence against its own conclusions.**
