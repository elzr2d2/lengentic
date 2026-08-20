# Parallel execution playbook

How to run the LenGentic harness with more than one agent at a time without the token bill
or the quality dropping. What is actually done is never in this file: `pnpm oracle status`
computes it, and `pnpm oracle md` writes the generated snapshot to
`.artifacts/oracle/PROJECT_STATUS.md`.

`MVP_PLAN_V3.md` §8 and `CLAUDE.md` still bind: one phase at a time, and a phase boundary is
a **validation gate, not an approval gate** — GREEN advances, RED enters bounded recovery,
and only the six escalation triggers reach the human. Parallelism happens **inside** a
phase, never across one.

The single entry point for "what happens next" is `pnpm flow next`. It returns one JSON
action — DISPATCH, WAVE_GATE, INTEGRATE, REPAIR, PHASE_GATE, ADVANCE_PHASE, BLOCKED,
COMPLETE — derived from the oracle's probes, the gate records under `.artifacts/gates/` and
the checkpoint. Everything below is how to execute the action it returns.

---

## 1. The oracle decides the fan-out, not you

```bash
pnpm flow next              # the one next action, as JSON
pnpm oracle status          # phase progress, open decisions, what is unblocked now
pnpm oracle unblock         # root causes of everything blocked, ranked by leverage
pnpm oracle waves <n>       # the parallel batches for phase n, plus lane collisions
pnpm oracle packet <id>     # a ready-to-dispatch work packet with the contract sliced in
```

`unblock` is the one to run when the matrix looks discouraging: N blocked deliverables is
usually a handful of root causes, and one or two of them are worth more than all the others
together. See §9.

A wave is the set of deliverables with no dependency on each other. Dispatching wider than
the wave does not go faster — the extra agents are working against files that do not exist
yet, and you pay for their confusion twice: once for the wrong output, once for the repair.
`pnpm oracle waves <n>` prints the current shape; do not work from a remembered one.

Peak useful parallelism in this project has measured **three**, and it is never one agent
per work package in the plan's tables — the plan's packages are not independent things.

## 2. Model tiering — the largest single lever

`MVP_PLAN_V3.md` §9 assigns models per role. The shipped `.claude/agents/*.md` files do not
match it:

| Role      | Plan §9     | `.claude/agents/*.md` | Runs how often                          |
| --------- | ----------- | --------------------- | --------------------------------------- |
| Architect | Opus High   | `opus`                | Rare — conditional, decision-gated only |
| Builder   | Sonnet High | `sonnet`              | Every packet                            |
| Validator | Sonnet      | **`opus`**            | Behavior wave gates + contract packets  |
| Reviewer  | Sonnet High | **`opus`**            | Wave gates (feature) and phase gates    |

Validator is the hot path — under `.claude/rules/agent-activation.json` it fires at every
behavior wave gate and on every contract packet. Its job — run commands, capture real
output, design adversarial cases — is execution-shaped, and Sonnet does it well.

Recommended, in priority order:

1. **Validator → `sonnet`.** Matches the plan. Biggest saving, smallest risk.
2. **Reviewer stays `opus` only if it stays rare.** The plan says Sonnet High; Opus is
   defensible for a gate that runs per wave or per phase, and indefensible if Reviewer
   starts running per packet. The activation rules already forbid the latter.
3. **Architect stays `opus`.** It is escalation. If it runs often, the problem is routing,
   not cost.

## 3. Slice the contract, do not ship the plan

`MVP_PLAN_V3.md` is roughly 25k tokens. A subagent that reads it to implement one merge rule
spends 25k tokens to acquire about 1k of constraint, and pays it again on every retry and
every agent in the wave.

`pnpm oracle packet <id>` emits ~1k tokens: the deliverable, its dependencies, any open
decision that gates it, and the relevant plan sections verbatim. Same constraint, same
verbatim wording, without the other twenty-five sections.

Rough arithmetic for a ten-deliverable phase, one Builder each:

```text
whole plan per agent     10 × 25k  = 250k tokens, before a line of code is written
sliced packets           10 × ~1k  =  10k tokens
```

The saving compounds with retries, and it also improves output: an agent given one section
alone cannot drift into re-litigating another.

**Rule: no subagent is ever told "read MVP_PLAN_V3.md".** It gets a packet.

## 4. Watch the lane collisions

`pnpm oracle waves` flags when two nodes in the same wave live in the same directory. Two
Builders editing one directory concurrently is the most expensive failure mode available:
you pay for both agents, then pay a third time to reconcile them, and the reconciliation is
exactly the kind of merge a model does badly. Options, cheapest first:

1. **Serialise them.** The wave becomes two dispatches. Usually right.
2. **Give one a git worktree** (`isolation: "worktree"`). Correct when both are large.
3. **Split the lane** so each owns a distinct module directory.

Never dispatch a colliding pair into the same working tree and hope.

## 5. Validate per wave, review per gate

Agent cadence is lifecycle-derived from `.claude/rules/agent-activation.json` — per packet,
per wave, or per phase, by change class. At three-wide, the loop `pnpm flow next` drives
looks like:

```text
dispatch wave (1-3 Builders, parallel, one message)
  → pnpm gates                      ← zero tokens, catches lint/type/boundary/test
  → wave gate agents per activation rules
      (one Validator over the wave's combined diff for behavior classes;
       Reviewer at the wave gate for feature classes)
  → Builder repairs validated failures
  → pnpm flow record wave ...       ← the gate record is what flow next reads
  → next wave
      ...
  → phase gate: Reviewer (+ Tester where the class requires it), pnpm gates:full once
  → validation gate: GREEN advances, RED enters bounded recovery
```

One Validator sees the whole wave's diff and catches interaction defects that three
single-packet Validators each miss by construction.

**Run `pnpm gates` before any validation agent, always.** Lint, typecheck, boundaries and
tests cost nothing and catch a large share of what a Validator would otherwise spend tokens
discovering. `CLAUDE.md` already states the principle: never ask an agent to verify what a
script can verify.

## 6. Batch the dispatch

Send a wave's agents as multiple tool calls in a **single message**. Sequential dispatch
serialises the wall clock for no benefit, and it breaks prompt-cache reuse across the
agent-definition prefix that all three Builders share.

Keep each agent's prompt prefix stable — same agent file, same standing rules, packet last.
Varying the prefix per agent defeats caching on the part that is identical anyway.

## 7. Open decisions are hard stops, not defaults

`pnpm oracle status` lists the open decisions and which deliverables each one gates.
`pnpm oracle packet` puts a **STOP** block at the top of any packet a decision gates, and
tells the agent to report `BLOCKED` rather than pick a default. This is deliberate: an agent
that silently defaults a product threshold has changed product behavior invisibly, and the
mistake surfaces phases later as a wrong number.

Answer the decisions that gate a wave before dispatching it — it is usually a five-minute
conversation that unblocks several parallel agents. Mark a decision `"answered": true` in
`scripts/oracle/graph.json` and the oracle stops flagging it.

## 8. Findings the dependency graph surfaced

The graph has repeatedly surfaced constraints the plan's phase tables did not show — most
consequentially that the analysis engine depended on nothing from Phases 2–4, which became
the amended execution order (`0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`, `MVP_PLAN_V3.md`
Part III, decided at the Phase 1 gate). The findings that drove it are recorded there, not
here. When the graph and the plan disagree about ordering, run `pnpm oracle unblock` and
take what it reports to the human as a scope decision — the graph reports that a constraint
is process, not technology; it never licenses starting a second phase on its own.

## 9. Unblocking, in leverage order

`pnpm oracle unblock` traces every blocked deliverable to a root cause a human can act on
today, ranked by how many nodes each unblocks. Three kinds of cause, three kinds of fix:

- **DECIDE** — an open decision. The plan usually already contains a written proposal; the
  fix is a human saying yes and `"answered": true` in `scripts/oracle/graph.json`. Do
  **not** let an agent default these (§7).
- **DISPATCH** — a root deliverable gating a subtree. Build it first, alone, and review it
  properly: everything downstream inherits its mistakes.
- **ENV** — a missing runtime (a daemon, a remote, a credential). Fix the environment or
  route the check through CI; either way the evidence belongs on disk under
  `.artifacts/`, where the oracle's probe can see it. A green run nobody recorded is not
  evidence next month.

## 10. The eligibility gate — fifteen requirements, all hard

Everything above is judgement. This section is the part that is not.

```bash
pnpm lanes wave 2                              # decide over the next wave of a phase
pnpm lanes decide p2.merge-rules p2.sdk-core   # decide over a specific set
```

It emits an `execution_decision` — mode, eligibility, reasons, blockers, dependency order,
shared contracts, per-lane ownership, and a verdict per requirement. **Sequential is the
default and unknown counts as false.** A requirement nobody checked is not a requirement
that passed.

| #   | Requirement                                    | Fails when                                                       |
| --- | ---------------------------------------------- | ---------------------------------------------------------------- |
| R1  | at least two meaningful work units             | one unit, or below `minUnits`                                    |
| R2  | explicit acceptance criteria                   | a node declares no probes                                        |
| R3  | known validation commands                      | a node has no `validate` array                                   |
| R4  | dependencies are known                         | an edge points at a node the graph does not have                 |
| R5  | no lane depends on another in the batch        | the batch is a sequence wearing a batch's clothes                |
| R6  | contracts frozen before fan-out                | an open decision, or an unbuilt upstream                         |
| R7  | `allowed_paths` do not overlap                 | two surfaces intersect, or one is undeclared                     |
| R8  | no two lanes modify the same file              | identical declarations                                           |
| R9  | no shared write surface                        | a lane claims a migration, lockfile or global config             |
| R10 | each lane validated independently              | no commands, or no surface                                       |
| R11 | each lane committed and reverted independently | a revert would reach into another lane                           |
| R12 | benefit exceeds overhead                       | fewer than `minUnits`, or a lane is not self-contained           |
| R13 | base safe for worktrees                        | mid-merge, conflicted, or uncommitted work inside a lane surface |
| R14 | context fits a bounded packet                  | no `sections` entry — the lane would be handed the plan          |
| R15 | no serialisation risk                          | `risk: high`, or the lane edits `platform/shared/schema/**`      |

**Annotation is the opt-in.** A node without `own.allowed` and `validate` in
`scripts/oracle/graph.json` fails R3, R7 and R10 and runs sequentially. That is deliberate:
inferring a write surface from a lane label is exactly the guess that puts two Builders in
one directory. Adding an annotation is a decision about ownership, not a formality.

The overlap check is **conservative**. Two patterns are called overlapping when one's
literal prefix contains the other's, so `platform/api/src/a/**` and `platform/api/src/b/**`
are reported as colliding. A false overlap costs one sequential batch; a missed one costs
two agents and a merge a model does badly.

Default concurrency is **2**, in `lanePolicy.maxConcurrency`. `--max` overrides it for one
run. Nothing raises it automatically — §1 already found that peak useful parallelism here is
three, and the cap exists so a wide wave does not become a wide dispatch by default.

## 11. Ownership, isolation, and the integration gate

Four gates, each with a command.

**Pre-dispatch** — `pnpm lanes decide`. Requirements, ownership, dependencies, frozen
contracts, verified commands.

**Pre-commit, per lane** — `pnpm lanes check <id>`, then the lane's own packet validation
commands, then the pre-commit hook's staged-scope ladder (`scripts/precommit.ts`) at commit
time. `lanes check` compares the lane's changed files against its declared surface. Inside a
lane worktree, `.claude/hooks/check-lane-ownership.mjs` refuses an out-of-surface write at
the moment it is attempted, driven by `.artifacts/lanes/current.json`. No lane file means no
lane and no enforcement — the main session is not a lane.

**Pre-integration** — `pnpm lanes integrate <id...>`. Handoff present and valid against
`.claude/rules/lane-handoff.schema.json`, status `DONE`, commit resolves, changed files
inside the surface, no collision with an already-integrated lane. It stops at the first
failure and integrates nothing past it. It gates; it does not merge.

**Post-integration** — each lane's own commands after its merge, then `pnpm gates` once for
the wave. `pnpm gates:full` runs at the phase gate and in CI only — per-lane or per-wave
`gates:full` would pay `check:isolation` — a full install and build in a temp checkout —
repeatedly for a question with one answer per phase.

Isolation setup is printed, never executed:

```bash
pnpm lanes worktrees p2.merge-rules p2.sdk-core
```

Cleanup is deliberately not scripted. Removing a worktree discards uncommitted lane work.

A failed lane halts its dependents and nothing else — `halts_if_failed` and
`independent_of` on each lane entry say exactly which is which.

The rules themselves are checked: `pnpm check:lanes` runs the workflow scenarios, including
the hook as a real process with real exit codes. It is wired into CI and is deliberately
**not** in `pnpm gates`, so the product gate keeps working with `.claude/` deleted.

## 12. What this playbook does not claim

The oracle's probes check presence, not correctness — a file exists, a symbol appears, a
script is declared. `pnpm oracle status` saying `DONE` means the deliverable is on disk, not
that it works. Correctness is `pnpm gates`, the test suite, and the phase validation gate,
in that order. A green oracle and a red gate means the gate is right.
