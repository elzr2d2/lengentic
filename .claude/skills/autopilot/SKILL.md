---
name: autopilot
description: Drive development across already-approved MVP phases without per-step approval — capture the charter once, then execute what `pnpm flow next` returns, gate at the cheapest sufficient tier, and advance on evidence, escalating only on the six triggers. Use when the human asks for autonomous or unattended development, or says "autopilot".
---

# Autopilot

You are the Coordinator. Autopilot removes the **approval gate** between steps; it moves the
decision nowhere else. No subagent dispatches subagents, no subagent chooses the next phase,
and every dispatch still routes through `pnpm lanes wave` / `pnpm lanes decide`.

**Core rule: do the cheapest sufficient thing.** Run the lowest validation tier that
establishes the evidence, dispatch the fewest agents that produce it, re-read the least
context that answers the question. Autopilot is an executor, not a ceremony engine. Removing
overhead is the goal; removing a quality control is not.

`pnpm autopilot` runs this loop across sessions without a human — one disposable worker per
action, `ROTATE` when a worker runs out of context. `docs/AUTOPILOT_SUPERVISOR.md` is the
mechanism, `docs/decisions/0012` is why. This skill is the same loop by hand and stays the
debugging path. If you are a supervised worker you already have one task and one envelope:
do that, do not re-enter the loop.

## 0. Charter — once per invocation

The charter is what makes trigger 3 answerable without asking the human twelve times. Land
the objective and the standing preferences as a decision record before the first dispatch,
and write its path into the checkpoint.

Grill (`grilling`) **only** what the human's directive left open. A directive that already
states the objective and the preferences **is** the charter — record it and move. Re-asking
what was just answered is the overhead this skill exists to delete. `docs/decisions/0011` is
the shape.

## 1. Resume — never restart

Read state from disk and continue from the **first incomplete action**.

| Order | Source                                       | Answers                                       |
| ----- | -------------------------------------------- | --------------------------------------------- |
| 1     | `pnpm flow next`                             | the one next action, with its steps           |
| 2     | `pnpm oracle status` / `pnpm lanes wave <n>` | what is genuinely done and what is unblocked  |
| 3     | `.artifacts/handoffs/*.json`                 | per-lane `DONE` / `BLOCKED` with its evidence |
| 4     | `.claude/autopilot.local.md`                 | recovery history — and nothing else           |

Rows 2 and 3 are authoritative on completion. The checkpoint is authoritative on **recovery
history only**; where it disagrees with `oracle`, `oracle` wins and the checkpoint is
corrected.

**`pnpm lanes wave` exit codes are honest.** `PHASE_COMPLETE` with exit 0 means the phase is
finished — gate it (§3), then advance; never enter recovery on it. Non-zero is a real failure.

**Reconcile `step: recovering` before honoring it.** Re-check the named node against row 2.
If the oracle reports it `DONE`, or ready with the recovery's fix already on its lane branch,
the bookkeeping is stale: record the attempt's outcome from the evidence on disk, discard the
`recovering` step, re-enter the loop. Recovery resumes only for a red reproducible **now**,
never because the checkpoint says so.

Checkpoint — rewrite at every step boundary, not only on failure:

```markdown
---
phase: 5a
wave: 3
step: dispatched # framed | dispatched | gated | validated | recovering
charter: docs/decisions/00NN-<slug>.md
---

## Recovery log

### 5a / wave 3 — gate: wave — attempt 1

- diagnosis: <cause, with the evidence that established it>
- fix: <the whole repair set, one entry — what changed and where>
- narrow validation: <command> → <result>
- outcome: spent | resolved
```

## 2. The loop — execute what `flow next` returns

`pnpm flow next` is the entry point at every iteration. It derives the action from the
oracle's probes, the gate records and the checkpoint, and returns the action **with its
steps**. Execute those steps. Re-deriving them in prose is the judgement dispatch `CLAUDE.md`
forbids, and re-reading the roadmap to confirm what the control plane just told you is the
context spend this skill exists to remove.

Execution order is `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`. Phase numbers are identity, not
sequence — `flow next` already walks it.

| Action          | Level  | Do                                                             |
| --------------- | ------ | -------------------------------------------------------------- |
| DISPATCH        | PACKET | §2.1 — Builders, concurrently, up to `max_concurrency`         |
| INTEGRATE       | WAVE   | `pnpm lanes integrate <ids>`, merge in the printed order       |
| WAVE_GATE       | WAVE   | §2.2                                                           |
| PHASE_GATE      | PHASE  | §2.3                                                           |
| ADVANCE_PHASE   | —      | triggers 2 and 3 against the next segment, rewrite frontmatter |
| REPAIR          | —      | §4                                                             |
| BLOCKED / ERROR | —      | trigger 5 — stop, report with evidence                         |
| COMPLETE        | —      | done                                                           |

**Framing is conditional.** Run `frame-phase` for the next ready wave only when it has open
decisions. `open decisions: none` means framing is complete — proceed straight to dispatch. An
open decision the charter, `docs/decisions/` or the plan cannot settle is trigger 3: ask, do
not default it.

Then rewrite the checkpoint and ask `flow next` again. That is the whole loop.

### 2.1 PACKET — Builder → targeted validation → DONE

One Builder per packet. Builder owns implementation **and** the immediate repair of obvious
failures — a failing assertion it just wrote is not a gate failure and does not need a second
agent.

Validation is the packet's own surface only: affected unit tests, relevant integration tests,
typecheck and lint for the touched packages, the packet's `validate` commands, `pnpm lanes
check <id>`. The pre-commit ladder (`scripts/precommit.ts`) covers the staged rest. **Never
run `pnpm gates` per packet** — that is the wave gate's job, once, over the integrated wave.

No Validator, Reviewer, Tester or Watchdog per packet unless the printed `review_cadence`
block puts it there (only the `contract` class does), or an `activationConditions` entry in
`.claude/rules/agent-activation.json` actually fires. Follow the printed cadence: never re-add
a review it removed, never waive one it kept.

Dispatch **every** packet `flow next` lists as dispatchable, concurrently, up to
`max_concurrency` from `pnpm lanes decide` — do not serialize independent lanes by hand, and
do not hold a ready lane back for a wave boundary that has not arrived. When the decision is
`sequential`, that is the fifteen requirements failing, not a preference: read `blockers`,
repair what is repairable, do not override it. Worktrees per `dispatch-lanes` §3. As each lane
returns, validate it while the others keep working; no barrier, no idle Builder.

### 2.2 WAVE — integration evidence only

`pnpm gates` once over the integrated wave, plus the `perWave` agents `flow next` prints (one
dispatch each, over the wave's **combined** diff), plus whatever interaction checks the
changed components actually need. Flush `.artifacts/backlog/pending.md` into `BACKLOG.md`,
then `pnpm flow record wave …`.

Not `gates:full` — unless this wave is also the phase boundary, or a specific failure names an
isolation problem.

### 2.3 PHASE — the only full gate

Only when every in-scope packet is `DONE` and wave-gated:

1. `pnpm gates:full`
2. `validate-phase` against the phase Definition of Done
3. the `perPhase` agents `flow next` prints — Reviewer, and Tester where the class calls for it
4. flush the pending backlog
5. `pnpm flow record phase …` when GREEN

GREEN advances **immediately, without asking**. Check triggers 2 and 3 against the next
segment before its first dispatch — a phase already known to need a scope decision is asked
about before it starts, not after a wave of Builders has shipped.

### 2.4 Validation tiers

| Tier   | Scope                                  | Cost            |
| ------ | -------------------------------------- | --------------- |
| FAST   | targeted tests, typecheck, lint, smoke | inside the lane |
| PACKET | the packet's acceptance commands       | per packet      |
| WAVE   | `pnpm gates` + integration checks      | once per wave   |
| PHASE  | `gates:full` + DoD + Reviewer/Tester   | once per phase  |

Always the lowest tier that establishes sufficient evidence. Re-validating an unchanged
surface produces no new information.

## 3. GREEN — four sources that must agree

| Source             | Satisfied by                                                  |
| ------------------ | ------------------------------------------------------------- |
| Required gates     | `pnpm gates:full` (or the tier's own commands) exit 0         |
| Definition of Done | `validate-phase` reports every checkbox met, with evidence    |
| Expected artifacts | the phase's deliverables exist on disk, at their stated paths |
| Failure evidence   | no earlier red is still unexplained                           |

Any one alone is a green that lies. Gates passing while a `NOT MET` checkbox stands is RED. A
lane reporting `DONE` with a `deferred` acceptance criterion is RED — deferred, skipped and
unknown are all unverified.

**A finding tagged to another node is not an unexplained red for this node.** Only the
`this-node` count feeds the Failure-evidence row; a `<node-id>` finding is explained the moment
it is filed to `BACKLOG.md` with its trigger (`review-diff` §5).

Anything short of all four is RED → §4.

## 4. Bounded repair — one set, two strategies, per gate

An attempt is a **materially different, evidence-driven strategy** — running the same command
again is not one, and neither is the same fix applied twice.

The attempt belongs to the **gate**, not to a finding. Collect every actionable finding from
the failed gate into **one coherent repair set** and hand it to **one** Builder. One dispatch
per finding is overhead, not rigour.

```
attempt N, for N in 1..2, against this gate:
  diagnose      → only when the cause is unclear (Diagnostician, from BLOCKED).
                  A reproduced, obvious cause goes straight to Builder.
  repair        → one Builder, the whole set, scoped to the diagnosed causes
  revalidate    → the failed layer again, plus the narrowest checks that prove no regression
    failed  → this attempt is spent. N+1 must change the diagnosis or change the strategy.
              The same fix twice, or the same command again, is not an attempt.
    passed  → re-run the failed gate; §3 in full only if the failed gate was the phase gate
```

Do not restart the phase workflow after a repair. Do not re-run tiers the repair could not
have touched.

Both attempts spent without GREEN → **trigger 5**. Stop, report `BLOCKED` in the
`dispatch-lanes` §7 shape with both attempts' evidence quoted verbatim, ask. A standing record
may raise the bound (ADR 0011 does, to three materially different strategies); an attempt IS a
strategy, so raising the count raises the escalation bar and must name the record —
`scripts/autopilot/repair-policy.ts` enforces that.

One lane failing does not stop the others: `halts_if_failed` names who must stop, everything in
`independent_of` keeps going.

## 5. Dispatching agents — smallest useful context

Every dispatch carries: the objective, the acceptance criteria, the relevant files and modules,
directly related decision records, the current diff where it applies, and the exact validation
commands. `pnpm oracle packet <id>` produces exactly that for a packet. Never "read the plan",
never "read the repo" — an agent may follow the imports it needs and should not explore past
them.

**Reviewer blocks the gate only on** correctness, regressions, DoD violations, architectural
boundary violations, security/reliability, and maintainability hazards this diff introduced.
Style preferences, speculative improvements, optional refactors, alternative designs and
unrelated debt become `BACKLOG.md` items with their trigger — never blockers.

**Tester** falsifies the claims the work makes; it never redesigns the implementation. At the
phase gate it targets changed behavior, the DoD, regression boundaries and previously repaired
failures. Re-investigating proven, unchanged behavior without evidence of regression is spend,
not evidence.

## 6. The six triggers

They are in `CLAUDE.md` `## Plan discipline`. Read them there — a trigger paraphrased is a
trigger widened. Check them **before** each dispatch and each phase advance. When one fires,
stop and ask with the evidence attached. When none fires, decide, record the assumption, and
continue. "Shall I continue?" is not one of them.

## Reporting

```text
Phase 2 — 8/11 done
Running: p2.foo + p2.bar
Gate: not due
Blocked: none
```

```text
Phase 2 gate — RED
Repair attempt: 1/2
Findings: S1–S4, D1/D2
Next: Builder → targeted validation → re-gate
```

Detail goes to `.artifacts/`; return paths, not pasted content. Do not narrate internal agent
activity that does not change the execution state. Never omit a failure, a blocker, or missing
evidence — concision applies to what you add, never to what you observed.

## Red flags

| Thought                                 | Reality                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| "Shall I confirm before continuing?"    | Not a trigger. Continue.                                          |
| "I'll re-read the plan to be sure"      | `flow next` already answered. Read only what you will edit.       |
| "I'll run `gates:full` to be safe"      | Wave gate is `pnpm gates`. The full gate is the phase boundary.   |
| "One Builder per finding is cleaner"    | One coherent repair set, one dispatch. Attempts belong to gates.  |
| "I'll run these lanes one at a time"    | `mode` and `max_concurrency` decided that. Never serialize more.  |
| "Reviewer flagged style — gate is RED"  | Backlog it with its trigger. Only `this-node` correctness blocks. |
| "Gates are green, that's GREEN"         | One of four sources. Check the other three.                       |
| "I'll re-run the test, it might pass"   | A second green does not erase a first red. Not an attempt.        |
| "Same fix, but more thorough"           | Not a second strategy. The attempt is already spent.              |
| "The plan is ambiguous, I'll pick one"  | Two readings producing different work is Architect, or trigger 3. |
| "I'll widen the lane's paths to finish" | Report `BLOCKED` naming the path. Never widen.                    |
| "I'll skip the checkpoint, I remember"  | The next session does not. Write it.                              |
| "This phase looks done, next"           | `oracle` and `validate-phase` say done. Looking is not evidence.  |

## Done when

`flow next` returns COMPLETE with the last phase GREEN by all four sources, or a trigger has
fired and the human has the evidence. Report which of the two, never both.
