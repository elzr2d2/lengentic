---
name: dispatch-lanes
description: Decide sequential vs parallel for a batch of deliverables, dispatch lanes with bounded work packets, and integrate them in dependency order. Use before dispatching any implementation work, and whenever more than one deliverable looks ready at once.
---

# Dispatch Lanes

You are the Coordinator. `MVP_PLAN_V3.md` §9: the main session holds that role, and the
Integrator role too. Do not create an agent for either — a subagent that dispatches
subagents is a session that no longer sees the work it approves.

**Sequential is the default.** Parallel is an exception a batch earns against fifteen hard
requirements. You do not evaluate them by reading; `pnpm lanes decide` does, and unknown
counts as false.

## 1. Find the batch

```bash
pnpm flow next              # the one next action, as JSON — start here
pnpm oracle status          # what is done, what is unblocked
pnpm oracle unblock         # root causes, ranked by leverage — start here when everything looks blocked
pnpm lanes wave <phase>     # the next wave, already run through the eligibility gate
```

`pnpm flow next` is the entry point: when its action is `DISPATCH`, it names the packets and
the mode. `pnpm lanes wave` is the decision it derives from — it picks the lowest unfinished
wave in the phase and decides on it. Use `pnpm lanes decide <id...>` when you want a
specific set.

## 2. Read the decision, do not re-derive it

The output is `execution_decision`. Three fields decide what you do next:

- `mode: sequential` → run `dependency_order` one at a time. Stop reading.
- `mode: parallel` → go to step 3.
- `blockers` → each names a requirement id and the evidence. Fix the blocker or run
  sequentially; do not argue with it.

Do not re-analyse dependencies, paths, or risk yourself. That analysis is in
`scripts/oracle/graph.json` and the decision object, and redoing it in prose costs tokens
to produce a second opinion nothing downstream reads.

**Common blockers and what they actually mean**

| Blocker                          | Meaning                                                   | Fix                                                              |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `R3` unknown validation commands | the node has no `validate` array                          | add real, verified commands to the graph, or run it sequentially |
| `R6` contracts not frozen        | an upstream deliverable is unbuilt, or a decision is open | build the upstream first; answer the decision — never default it |
| `R7`/`R8` overlapping paths      | two lanes claim one directory                             | serialise, or split the surface so each lane owns a distinct one |
| `R9` shared write surface        | a lane claims a migration, lockfile or global config      | serialise. This one never has a parallel answer                  |
| `R13` unsafe base                | uncommitted work sits inside a lane's surface             | commit or stash it first                                         |
| `R15` serialisation required     | risk is high, or the lane edits the wire contract         | run it alone. Everything downstream inherits its mistakes        |

## 3. Isolate before dispatching

```bash
pnpm lanes worktrees <id...>
```

It prints the commands; run them yourself. Each lane gets its own branch, its own worktree,
and a `.artifacts/lanes/current.json` naming its surface — that file is what makes
`.claude/hooks/check-lane-ownership.mjs` refuse an out-of-lane write inside that worktree.

Never dispatch two lanes into one working tree. `docs/PARALLEL_EXECUTION.md` §4: you pay for
both agents, then pay a third time to reconcile them, and the reconciliation is exactly the
kind of merge a model does badly.

## 4. Dispatch packets, never the plan

```bash
pnpm oracle packet <id>
```

One packet per lane, all lanes dispatched **in a single message** so they run concurrently
and share the cached prompt prefix. The packet already carries scope, the sliced contract,
path ownership, validation commands, acceptance criteria, the agent chain for its change
class, and stop conditions.

**No subagent is ever told to read `MVP_PLAN_V3.md`.** It gets a packet. The plan is ~25k
tokens and the packet is about 1k of the same constraint.

Respect the packet's `required` / `optional` agent chain. Agents are conditional tools, not
a pipeline — the chain comes from `.claude/rules/agent-activation.json`, which is the one
place that decides who runs.

## 5. Gate each lane before it commits

Inside the lane, before the commit:

```bash
pnpm lanes check <id>       # diff scope: forbidden paths, out-of-surface writes
<the packet's validate commands>   # the lane's own acceptance evidence
```

The commit itself then runs the Tier 2 staged-scope ladder (`scripts/precommit.ts`) via the
pre-commit hook — secrets, format, lint, affected-package typecheck and test. The lane does
not run `pnpm gates`; that is the wave gate's job, once, over the integrated wave
(`run-quality-gates` tier table).

Run the deterministic checks before any validation agent, always. They cost no tokens and
catch a large share of what an agent would otherwise spend tokens discovering.

The lane returns `.artifacts/handoffs/<phase>-<id>-<owner>.json` shaped by
`.claude/rules/lane-handoff.schema.json`. `DONE` requires a commit SHA, changed files inside
the surface, and an empty `unverified` bucket. Deferred, skipped and unknown are all
`unverified` — there is no third bucket.

## 6. Integrate sequentially

```bash
pnpm lanes integrate <id...>
```

This is a gate, not an action. It validates every handoff, checks each commit resolves,
re-checks changed paths, detects collisions against already-integrated lanes, and prints the
ordered plan. It stops at the first failure and integrates nothing past it.

You perform the merges. Integration order is `dependency_order`, always sequential, whatever
the dispatch mode was.

After the whole batch is merged, the **wave gate** runs: `pnpm gates` once over the
integrated tree, then whatever `wave_gate_agents` the wave's change classes require from
`.claude/rules/agent-activation.json` (a Validator over the combined diff for behavior,
Reviewer for feature). Record it with `pnpm flow record wave ...` — the gate record is what
`pnpm flow next` reads.

`pnpm gates:full` runs at the **phase gate** and in CI only. Per-wave it would pay
`check:isolation` — a full install and build in a temp checkout — repeatedly to answer a
question with one answer per phase.

Do not delete worktrees or branches afterwards. That discards uncommitted lane work and is
a human decision.

## 7. When a lane fails

- One lane `BLOCKED` or `FAILED` does **not** stop the others. `halts_if_failed` on that
  lane names exactly who must stop; everything in `independent_of` keeps going.
- Cause unclear → Diagnostician, from `BLOCKED`, not from a low-confidence `FAILED`. A
  blocked validation reported as a failure sends Builder hunting a defect that may not exist.
- Two failed repair attempts → stop and report `BLOCKED` with both attempts. A third guess
  costs more than a handoff.
- Never retry silently, and never rerun until green. A second green does not erase a first
  red.

## Red flags

| Thought                                              | Reality                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| "These look independent enough"                      | Run `pnpm lanes decide`. "Enough" is not one of the fifteen requirements.         |
| "I'll just widen this lane's paths"                  | That is the collision the gate exists to prevent. Report `BLOCKED`.               |
| "The decision is open, I'll pick a sensible default" | An invisibly-made product decision surfaces three phases later as a wrong number. |
| "More agents will be faster"                         | Peak useful parallelism here is three, and the default cap is two.                |
| "I'll re-check the dependency graph myself"          | It is in the decision object. Reading it twice costs twice.                       |
| "Deferred that check, calling it done"               | Deferred is `unverified`. The handoff will not validate.                          |
