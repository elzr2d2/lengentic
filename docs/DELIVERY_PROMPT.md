# LenGentic — Delivery Prompt

What remains, which workflow runs each step, what may fan out, and where a failure goes.

Derived from `MVP_PLAN_V3.md`, `.claude/rules/agent-activation.json`,
`docs/PARALLEL_EXECUTION.md`, and `pnpm oracle waves`. Statuses are probed, not asserted —
re-run `pnpm oracle md` before trusting the counts.

---

## 0. The session prompt

Paste this at the start of a delivery session. Substitute the phase.

```text
You are the Coordinator for LenGentic. Deliver PHASE <n> of MVP_PLAN_V3.md.

Before anything:
  1. pnpm oracle waves            — the fan-out for this phase
  2. pnpm lanes wave <n>          — the execution_decision for the next wave
  3. Follow the execution_decision. Never dispatch by judgement.

Per work packet:
  - pnpm oracle packet <id>       — the bounded brief. Never hand a subagent the plan.
  - Route the packet by change class (mechanical / feature / behavior / contract /
    diagnosis) using .claude/rules/agent-activation.json. Agents are conditional tools,
    not a pipeline.
  - Every agent returns a handoff. Findings use .claude/rules/handoff.schema.json; a lane
    reporting its own work uses .claude/rules/lane-handoff.schema.json.
  - Run the deterministic gates BEFORE dispatching any validation agent.

Constraints:
  - One phase at a time. Never start the next phase automatically.
  - Anything valuable but not required by this phase's Definition of Done goes to
    BACKLOG.md, not into the phase.
  - A lane writes only inside its allowed_paths. Widening the boundary is never the
    answer; BLOCKED naming the path is.
  - DONE is a claim about evidence. Deferred, skipped and unknown are all unverified.
  - Report failures, blockers and uncertainty verbatim. Never omit them.

Finish with: pnpm gates, then the validate-phase skill against the phase DoD, then stop at
the human approval gate.
```

---

## 1. Where the work stands

```text
Phase 1  9/14   ready 3     blocked on Docker + 3 debt packets
Phase 2  0/10   ready 1     p2.shared-schema is the critical-path root
Phase 3  0/5    ready 0
Phase 4  0/6    ready 0
Phase 5  0/8    ready 1     p5.engine-pkg depends on nothing in phases 2–4
Phase 6  0/4    ready 0
Phase 7  0/5    ready 0
```

38 deliverables blocked, tracing to 4 root causes:

| Root cause          | Unblocks | Kind     |
| ------------------- | -------- | -------- |
| `p2.shared-schema`  | 32       | dispatch |
| `p5.engine-pkg`     | 15       | dispatch |
| `env.docker`        | 5        | env      |
| `p1.debt.precommit` | 1        | dispatch |

All open decisions are answered. No framing blocker for phases 1–7.

---

## 2. Step-by-step routing

Change class drives the agent chain. `.claude/rules/agent-activation.json` is the
authority; the table below is that file applied to the remaining packets.

| Class      | Required chain                                               | Optional         |
| ---------- | ------------------------------------------------------------ | ---------------- |
| mechanical | implement → execute                                          | review           |
| feature    | implement → execute → review                                 | integrity-scan   |
| behavior   | implement → execute → adversarial-test → review              | integrity-scan   |
| contract   | architecture → implement → execute → review → integrity-scan | adversarial-test |
| diagnosis  | diagnose → implement → execute                               | review           |

### Step 1 — Close Phase 1

| Packet                  | Class      | Workflow                                                                                                          |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `env.docker`            | human      | `wsl --install`, `winget install Docker.DockerDesktop`, reboot. No agent.                                         |
| `p1.debt.handoff-files` | feature    | Coordinator-only — `alwaysForbidden` to lanes. Builder in main session, then `pnpm lanes handoff` on a real file. |
| `p1.debt.precommit`     | mechanical | `setup-pre-commit` skill → Builder → `run-quality-gates`.                                                         |
| `p1.debt.secrets`       | mechanical | Builder → `run-quality-gates`.                                                                                    |
| `p1.docker-runtime`     | behavior   | Validator only, after Docker exists. Never Builder — nothing to build.                                            |

Gate: `docker-compose.yml` and both Dockerfiles have **never executed**. Treat them as
unreviewed until `docker compose up` runs once. That first run is a review surface, not a
smoke test.

Close with `validate-phase` against the 23-item Phase 1 DoD, then the human approval gate.

### Step 2 — Phase 2, first vertical slice

| Wave | Packets                                                 | Class              | Workflow                                                                                     |
| ---- | ------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| 1    | `p2.shared-schema`                                      | contract           | Architect → Builder → Validator → Reviewer → Watchdog. Alone.                                |
| 2    | `p2.merge-rules`, `p2.prisma-run-step`, `p2.sdk-core`   | feature / contract | `dispatch-lanes`; `p2.prisma-run-step` owns a migration → shared write surface → sequential. |
| 3    | `p2.ingest-endpoint`, `p2.runs-api`, `p2.sdk-injection` | behavior           | api-lane collision — serialise the first two.                                                |
| 4    | `p2.dashboard-runs`, `p2.idempotency`                   | feature / behavior | fan out.                                                                                     |
| 5    | `p2.integration-tests`                                  | behavior           | Validator. Needs Docker.                                                                     |

`p2.shared-schema` is the one packet worth the full chain. It fails R15 by construction —
anything editing `platform/shared/schema/**` is serialisation risk — so it never runs in a
lane with anything else.

`p2.merge-rules` and `p2.payload-safety`-style pure functions: write the negative fixtures
first (`test-at-seams`). False positives are the failure mode that kills this product.

`p2.sdk-injection` is a plan gap the oracle flags: v3 assigns seeded Clock/IdGen to Phase 3
WP4, but the seams live in the SDK. Land them in Phase 2 or Phase 3 reopens Phase 2 code.

### Step 3 — Phase 5 engine, early and out of order

`p5.engine-pkg` depends on nothing in phases 2–4 — the spike already proved the functions.
It can be built the moment the workspace exists, in parallel with Phase 2, provided it does
not collide with a Phase 2 lane surface. Followed by `p5.negative-fixtures` (behavior;
negative before positive, always).

This is the single largest schedule lever after `p2.shared-schema`.

### Step 4 — Phases 3, 4, 6, 7

| Phase | Shape                                                                                                           | Notes                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | scaffold → 3 parallel (mock provider, seeded clock, strategy evaluator) → mock agent → CLI + strategy telemetry | Whole phase lives in one `playground` lane — two collisions. `p3.strategy-evaluator` is a pure function testable without telemetry.                                              |
| 4     | entities + payload-safety + sdk-decisions → attestation + run-explorer + run-summary                            | `p4.entities` is a migration (contract). `p4.run-summary` is a plan gap placed here; its `repeated failed actions` field depends on `p5.repeated-failed` — ship that field last. |
| 5     | det-candidate + repeated-failed → rec-persistence + spike-deleted → analysis-endpoint → recs-ui                 | `engine` lane collision in wave 3. `p5.spike-deleted` deletes `spike/` — irreversible, Watchdog before it runs.                                                                  |
| 6     | 4 scenarios in parallel → seed reproducibility validator                                                        | All four in the `playground` lane. `p6.real-provider` must not block MVP.                                                                                                        |
| 7     | docker-smoke + e2e + readme + regression → ci-full                                                              | Three of four are Validator packets. E2E 4 is the **silence case** — the system must emit nothing.                                                                               |

---

## 3. What can actually run in parallel

Two different answers, and the second is the one that governs.

**What the graph allows** — `maxParallel` per phase: P1 3, P2 3, P3 2, P4 3, P5 2, P6 4,
P7 4.

**What the gate permits today** — only Phase 2's ten nodes carry `own.allowed` and
`validate` in `scripts/oracle/graph.json`. Every other phase fails R3, R7 and R10 and runs
**sequential**. That is deliberate, not an oversight: inferring a write surface from a lane
label is the guess that puts two Builders in one directory.

So the real parallel plan is:

1. Phase 2 fans out today, at `lanePolicy.maxConcurrency: 2`.
2. Any other phase that should fan out needs its nodes annotated **first**. Annotation is a
   decision about ownership — dispatch it as its own packet, before the wave it enables.
3. Peak useful parallelism measured here is three. The cap is 2 by default; `--max`
   overrides for one run. Nothing raises it automatically.

Never dispatch by judgement:

```bash
pnpm lanes wave <phase>                        # decide over the next wave
pnpm lanes decide <id> <id>                    # decide over a specific set
pnpm lanes worktrees <id> <id>                 # prints isolation setup; never executes it
```

Sequential is the default and **unknown counts as false**. A requirement nobody checked is
not a requirement that passed.

Lane collisions the oracle already found — isolate or serialise each:

```text
P1 w2  infra       p1.debt.secrets + p1.docker-runtime
P2 w3  api         p2.ingest-endpoint + p2.runs-api
P3 w2  playground  p3.mock-provider + p3.seeded-clock + p3.strategy-evaluator
P3 w4  playground  p3.cli + p3.strategy-telemetry
P4 w1  sdk         p4.payload-safety + p4.sdk-decisions
P4 w2  api         p4.attestation + p4.run-summary
P5 w3  engine      p5.det-candidate + p5.repeated-failed
P6 w1  playground  p6.real-provider + p6.scenario1 + p6.scenario2 + p6.scenario3
P7 w1  test        p7.e2e + p7.regression
```

Four gates, each with a command:

| Moment           | Command                                            | Answers                                           |
| ---------------- | -------------------------------------------------- | ------------------------------------------------- |
| pre-dispatch     | `pnpm lanes decide`                                | fifteen requirements, ownership, frozen contracts |
| pre-commit, lane | `pnpm lanes check <id>` then `pnpm gates`          | did the lane stay inside its surface              |
| pre-integration  | `pnpm lanes integrate <id...>`                     | handoff real, commit resolves, no collision       |
| post-integration | per-lane commands, then `pnpm gates:full` **once** | isolation, one answer per batch                   |

Integration is sequential in dependency order whatever the dispatch mode was. Worktrees and
branches are never deleted automatically — removing one discards uncommitted lane work.

---

## 4. When something fails

Route by what the failure **is**, not by how loud it was.

| Symptom                                                 | Route                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Gate red — lint / typecheck / test / build              | `run-quality-gates`, quote real output, Builder repairs. No agent chain.                                         |
| `pnpm check:boundaries` red                             | Forbidden import. Builder fixes the import. Reviewer does **not** adjudicate boundaries — they are mechanical.   |
| `pnpm check:isolation` red                              | Platform gained a Playground dependency, or the SDK reached past `platform/shared`. Contract class.              |
| Handoff `FAILED` — reproduced, cause clear              | Builder, bounded repair, re-validate. `FAILED` requires reproduction; an unevidenced failure is an opinion.      |
| Handoff `BLOCKED` — cause unclear                       | **Diagnostician.** Only from `BLOCKED`, never from a low-confidence `FAILED`. Diagnoses; never fixes.            |
| Reproduced failure survived one bounded repair          | Diagnostician. A second guess that turns green is the worst outcome available.                                   |
| Lane wrote outside `allowed_paths`                      | `BLOCKED` naming the path. The hook refuses the write at the moment it is attempted. Never widen the boundary.   |
| Lane failed mid-batch                                   | Halts its dependents and nothing else — `halts_if_failed` / `independent_of` say which.                          |
| `pnpm lanes integrate` stopped at a lane                | It integrates nothing past the failure. Fix that lane, re-run. Do not hand-merge around it.                      |
| Tests green but behavior wrong                          | A green that lies. `validator` / `tester` — false-green detection, mutation check. `pnpm check:integrity` first. |
| Diff touches test files and product files together      | Watchdog integrity scan fires (activation condition, not a habit).                                               |
| Two readings of the plan give materially different work | Architect. Also when the change defines an interface others build against.                                       |
| Same mistake pattern twice                              | Reflector, and record the triggering failure in `BACKLOG.md`.                                                    |
| A valuable idea outside the current DoD                 | `update-backlog`, immediately. Not into the phase.                                                               |
| Docker probe fails                                      | Environment, not code. `BLOCKED` on `env.docker`. Five deliverables wait on it; nothing else should.             |

Escalation triggers, verbatim from §9:

```text
Architecture uncertainty            → Architect
BLOCKED handoff, cause unclear      → Diagnostician
Same mistake pattern twice          → Reflector
```

Diagnostician and Reflector are created **only when a real failure demands them**. If
neither is ever created, that is a valid outcome.

Role separation is structural and is not a preference: Reviewer has no `Write`/`Edit`;
Validator has no `Edit` and may write test files and fixtures only. A Reviewer that silently
fixes its own finding has destroyed the reason the role exists. Do not add the tools back.

---

## 5. Skills, by moment

| Moment                                                      | Skill                |
| ----------------------------------------------------------- | -------------------- |
| starting a phase, or a packet resting on an unmade decision | `frame-phase`        |
| more than one deliverable looks ready                       | `dispatch-lanes`     |
| before writing any test                                     | `test-at-seams`      |
| writing anything that reports progress                      | `structured-logging` |
| before claiming complete, before a handoff, before a commit | `run-quality-gates`  |
| before a commit or at a phase gate                          | `review-diff`        |
| before returning any finding or verdict                     | `report-handoff`     |
| a good idea the current DoD does not need                   | `update-backlog`     |
| a phase looks finished                                      | `validate-phase`     |

---

## 6. Standing rules that survive every phase

- Recommendations are hypotheses with counterevidence. `counterexamples` may be empty; it is
  never omitted.
- "Attested success rate", never "measured". LenGentic observes chosen options and attested
  outcomes, never counterfactuals — it may never claim a decision "does not require an LLM".
- Negative fixtures before the positive path, every analyzer.
- Prisma types never cross a module boundary. `platform/shared/schema/**` is the only wire
  contract.
- `.claude/` is engineering infrastructure. The product must run with it deleted; the
  platform must run with the whole playground deleted.
- Every completed phase leaves the repository runnable.
- A structured log never authorizes its own success. Cite it by `eventId` alongside tests,
  commands and read-back.
