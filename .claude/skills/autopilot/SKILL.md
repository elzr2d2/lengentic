---
name: autopilot
description: Drive development across already-approved MVP phases without per-step approval — capture the charter once, then frame, dispatch, gate and advance on evidence, escalating only on the six triggers. Use when the human asks for autonomous or unattended development, or says "autopilot".
---

# Autopilot

You are the Coordinator. That does not change here. Autopilot removes the **approval gate**
between steps; it does not move the decision anywhere else. No subagent dispatches subagents,
no subagent chooses the next phase, and every dispatch still routes through `pnpm lanes wave`.

Autopilot **owns** phase progression. If `/loop` is running underneath, it exists only to wake
this session up for the next iteration — it never decides a phase, a wave, or a dispatch.

## 0. Charter — once per invocation

Run `grill-with-docs`. Land the objective and the standing preferences as ADRs and glossary
entries, per that skill.

This is not ceremony. Trigger 3 asks whether a preference can be inferred; the charter is what
makes the answer yes. A preference never captured is a question you will ask the human twelve
times.

Write the charter path into the checkpoint before the first dispatch.

## 1. Resume — never restart

Read state from disk before every iteration and continue from the **first incomplete action**.
An autopilot that re-runs finished work burns the context window it needs later.

| Order | Source                                           | Answers                                                                   |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 1     | `.claude/autopilot.local.md`                     | which phase, which wave, which step, what recovery has already been tried |
| 2     | `pnpm oracle status` / `pnpm lanes wave <phase>` | what is genuinely done and what is unblocked                              |
| 3     | `.artifacts/handoffs/*.json`                     | per-lane `DONE` / `BLOCKED` with its evidence                             |

**`pnpm lanes wave` exit codes are honest.** `PHASE_COMPLETE: no outstanding work in phase
<phase>` with exit 0 means the phase is finished — check GREEN (§3), then advance; never enter
recovery on it. A non-zero exit is a real failure (unknown phase, broken graph, unclassified
node): RED, go to §4.

Rows 2 and 3 are authoritative on completion. The checkpoint is authoritative on **recovery
history only** — it is the one fact with no other home. Where the checkpoint and `oracle`
disagree about what is done, `oracle` wins and the checkpoint is corrected.

**Reconcile `step: recovering` before honoring it.** A checkpoint frozen mid-recovery outlives
the recovery whenever later work lands without the file being rewritten. Before resuming a
recovery, re-check the named node against row 2. If the oracle reports it `DONE`, or reports it
ready with the recovery's fix already on its lane branch, the recovery bookkeeping is stale:
record the attempt's outcome from the evidence on disk, discard the `recovering` step, and
re-enter the normal loop — the node's required agent chain re-verifies whatever the recovery
produced. Recovery is resumed only for a red that is reproducible now; it is never resumed
because the checkpoint says so.

The checkpoint:

```markdown
---
phase: 5a
wave: 3
step: dispatched # framed | dispatched | gated | validated | recovering
charter: docs/decisions/00NN-<slug>.md
---

## Recovery log

### 5a / wave 3 / p5.det-candidate — attempt 1

- diagnosis: <cause, with the evidence that established it>
- fix: <what changed, and where>
- narrow validation: <command> → <result>
- outcome: spent | resolved
```

Rewrite it at every step boundary. A checkpoint written only on failure is a checkpoint that is
wrong exactly when it is needed.

## 2. The phase loop

Walk `MVP_PLAN_V3.md`'s execution order — `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7` — starting at
the first incomplete phase. Phase numbers are identity, not sequence.

`pnpm flow next` drives the loop: run it at every iteration and execute the one action it
returns — DISPATCH, WAVE_GATE, INTEGRATE, REPAIR, PHASE_GATE, ADVANCE_PHASE, BLOCKED,
COMPLETE. It derives the action from the oracle's probes, the gate records under
`.artifacts/gates/`, and the checkpoint; re-deriving it in prose is the judgement dispatch
`CLAUDE.md` forbids.

For each phase:

1. **Frame** — `frame-phase`. Its own rule stands: a phase framed with one open decision
   remaining stops mid-wave. An open decision that the charter, `docs/decisions/` or the plan
   cannot settle is trigger 3 — ask, do not default it.
2. **Dispatch** — when `flow next` says DISPATCH: `pnpm lanes wave <phase>`, then the
   `dispatch-lanes` procedure verbatim. Read `execution_decision`; never re-derive it.
   Sequential is the default.
3. **Gate** — the GREEN check in §3.
4. **Advance** — GREEN advances immediately, no permission asked. Before advancing, check
   triggers 2 and 3 against the _next_ phase — a phase whose framing is already known to need a
   scope decision is asked about before it starts, not after a wave of Builders has shipped.
5. **Checkpoint** — write it, then iterate.

## 3. GREEN — four sources that must agree

GREEN is not an exit code and it is not an agent saying so. All four, together:

| Source             | Satisfied by                                                  |
| ------------------ | ------------------------------------------------------------- |
| Required gates     | `pnpm gates` (or the packet's own `validate` commands) exit 0 |
| Definition of Done | `validate-phase` reports every checkbox met, with evidence    |
| Expected artifacts | the phase's deliverables exist on disk, at their stated paths |
| Failure evidence   | no earlier red is still unexplained                           |

Any one alone is a green that lies. `pnpm gates` passing while a `NOT MET` checkbox stands is
RED. A lane reporting `DONE` with a `deferred` acceptance criterion is RED — deferred, skipped
and unknown are all unverified.

**A finding tagged to another node is not an unexplained red for this node.** `review-diff` §5
tags every finding `this-node`, a `<node-id>`, or `plan`. Only the `this-node` count feeds the
Failure-evidence row. A `<node-id>` finding is explained the moment it is filed to
`BACKLOG.md` with its trigger — it is that node's acceptance criterion, and holding this gate
open on it makes every gate inherit the whole downstream design.

Agent cadence is **lifecycle-derived**: each change class in
`.claude/rules/agent-activation.json` carries `perPacket` / `perWave` / `perPhase` /
`conditional`, and `pnpm lanes wave` / `pnpm lanes decide` turn that into the printed
`review_cadence` block mechanically — review per wave for feature, validation per wave and
review at the phase gate for behavior, the full per-packet chain only for contract. Follow
the printed cadence; never re-add a per-packet review the decision removed, and never waive
one it kept.

Anything short of all four is RED. Go to §4.

## 4. Bounded recovery — two strategies, not two retries

An attempt is a **materially different, evidence-driven strategy**. Running the same command
again is not an attempt, and neither is the same fix applied twice.

```
attempt N, for N in 1..2:
  diagnose          → Diagnostician, from BLOCKED — never from a guessed FAILED cause
  targeted fix      → Builder, scoped to that diagnosed cause and nothing else
  targeted validate → the narrowest command that exercises only this fix
    failed  → this attempt is spent. Attempt N+1 must change the diagnosis or change
              the fix strategy. Repeating either is not an attempt.
    passed  → re-run the full §3 GREEN check, all four sources
```

Both attempts spent without GREEN → **trigger 5**. Stop. Report `BLOCKED` in the
`dispatch-lanes` §7 shape, with both attempts' evidence quoted verbatim, and ask.

Never retry silently. Never re-run until green — a second green does not erase a first red.

One lane failing does not stop the others: `halts_if_failed` names exactly who must stop, and
everything in `independent_of` keeps going.

## 5. The six triggers

They are in `CLAUDE.md` `## Plan discipline`. Read them there; do not restate them from memory
here or in a handoff — a trigger paraphrased is a trigger widened.

Check them **before** each dispatch and each phase advance. When one fires, stop and ask with
the evidence attached. When none fires, decide, record the assumption, and continue.

## Red flags

| Thought                                 | Reality                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| "Shall I confirm before continuing?"    | Not a trigger. Continue.                                          |
| "Gates are green, that's GREEN"         | One of four sources. Check the other three.                       |
| "I'll re-run the test, it might pass"   | A second green does not erase a first red. Not an attempt.        |
| "Same fix, but more thorough"           | Not a second strategy. The attempt is already spent.              |
| "The plan is ambiguous, I'll pick one"  | Two readings producing different work is Architect, or trigger 3. |
| "I'll widen the lane's paths to finish" | Report `BLOCKED` naming the path. Never widen.                    |
| "I'll skip the checkpoint, I remember"  | The next session does not. Write it.                              |
| "This phase looks done, next"           | `oracle` and `validate-phase` say done. Looking is not evidence.  |

## Done when

The last phase in the execution order is GREEN by all four sources, or a trigger has fired and
the human has the evidence. Report which of the two, and never both.
