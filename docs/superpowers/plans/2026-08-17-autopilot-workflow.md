# Autopilot Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/autopilot` skill that captures the session charter once via `grill-with-docs`, then drives development across already-approved MVP phases on evidence, stopping only on six named escalation triggers.

**Architecture:** Three markdown edits and one new skill directory. No executable code, no new dispatch mechanism, no coordinator agent. Autopilot is a procedure the main session reads and follows — it sequences skills that already exist (`grill-with-docs`, `frame-phase`, `dispatch-lanes`, `validate-phase`) and reads state that already exists (`pnpm oracle status`, `pnpm lanes wave`, `.artifacts/handoffs/*.json`). The only new persistent state is one git-ignored checkpoint file holding recovery-attempt history, which has no other home.

**Tech Stack:** Markdown skill files under `.claude/skills/`, git, pnpm workspace scripts (`gates`, `oracle`, `lanes`, `check:kb`, `check:lanes`, `check:probes`).

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- `.claude/` is engineering infrastructure only. Engineering Agents must never become runtime dependencies. LenGentic must run correctly if `.claude/` is deleted.
- The main session is the **Coordinator**. There is no coordinator agent. `agent-activation.json` `controlPlane` is **not** edited by this plan.
- `MVP_PLAN_V3.md` is the single executable plan. `MVP_PLAN.md` (v2) and `docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md` are `[HISTORICAL]` and must not be cited as authority by anything this plan writes.
- Sequential execution is the default. Parallel is an exception a batch earns via `pnpm lanes decide`. Autopilot never dispatches by judgement.
- `DONE` is a claim about evidence, not about a green exit code.
- Every completed phase must leave the repository runnable.
- Be extremely concise in skill prose. Bullets and tables over paragraphs.
- Execution order is `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`. Phase numbers are identity, not sequence.
- Do not expand scope. Anything valuable but unnecessary goes to `BACKLOG.md`.

## File Structure

| File                                     | Change                                           | Responsibility                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                              | Modify (`## Plan discipline`, one line replaced) | The rule of record: replaces the unconditional phase-advance ban with bounded autonomy + six triggers.                                                 |
| `.claude/skills/validate-phase/SKILL.md` | Modify (`## Then stop` section; plan pointer)    | Removes the second copy of the same ban, which would halt autopilot at every phase boundary. Repoints the Definition-of-Done read at `MVP_PLAN_V3.md`. |
| `.gitignore`                             | Modify (append)                                  | Keeps `.claude/*.local.md` session state out of git.                                                                                                   |
| `.claude/skills/autopilot/SKILL.md`      | Create                                           | The procedure itself: charter, resume, per-phase loop, GREEN definition, bounded recovery, escalation triggers.                                        |

Ordering rationale: Tasks 1 and 2 remove the two rules that forbid the behaviour; Task 3 adds the behaviour. Building Task 3 first would land a skill that contradicts two documents in the same repo.

---

### Task 1: Replace the phase-advance ban in `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md:49` (inside `## Plan discipline`)

**Interfaces:**

- Consumes: nothing.
- Produces: the six escalation triggers, worded exactly as written here. Task 3's skill references them as "the six triggers in `CLAUDE.md` `## Plan discipline`" and must not restate them in different words.

- [ ] **Step 1: Read the section to confirm the exact target text**

Read `CLAUDE.md` lines 38–60. Confirm this line exists on its own, surrounded by blank lines:

```
Never automatically begin the next MVP phase.
```

Expected: exactly one match at line 49. If the line has moved, use its new location; if it has changed wording, stop and report — the rest of this plan assumes it is present verbatim.

- [ ] **Step 2: Replace that one line**

Replace the single line above with this block, verbatim:

```markdown
Once the human approves a session objective, the main session advances through already-approved
phases on evidence. Routine steps — task execution, agent handoffs, implementation, tests,
fixes, reviews, commits, and the transition into an already-approved phase — do not need
permission. Decide from `CLAUDE.md`, `CONTEXT.md`, `MVP_PLAN_V3.md`, `docs/decisions/`, and
prior evidence; document the assumption; continue. Prefer the reversible option under
uncertainty.

A phase boundary is a **validation gate, not an approval gate**. GREEN advances. RED enters
bounded recovery. Only the six triggers below reach the human.

**Escalation triggers — stop and ask, no exceptions:**

1. The action is destructive or hard to reverse.
2. It materially changes approved product scope or architecture.
3. A high-impact decision where no preference can be safely inferred from project rules, ADRs,
   prior decisions, or the approved plan.
4. Credentials, external cost, production systems, security, privacy, or legal/compliance are
   involved.
5. A required gate fails and two materially different, evidence-driven recovery attempts have
   both failed.
6. Requirements genuinely conflict and choosing one would invalidate another.

Triggers are checked **before** each dispatch and each phase advance, not only after a failure.
"Shall I continue?" is not one of them. The `autopilot` skill is this rule made procedural.
```

- [ ] **Step 3: Verify the old rule is gone and the new one is present**

Run: `pnpm kb search escalation triggers phase advance`

Expected: hits citing `CLAUDE.md` in the `## Plan discipline` section. Then grep `CLAUDE.md` for `Never automatically begin` — expected: **zero** matches in `CLAUDE.md`. Matches in `MVP_PLAN.md` (v2, `[HISTORICAL]`) and in the spec doc's quoted block are correct and must be left alone.

- [ ] **Step 4: Confirm the retrieval index still builds**

Run: `pnpm check:kb`

Expected: exit 0. This gate reads the documents, so a malformed heading or broken structure surfaces here.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "rules: a phase boundary is a validation gate, not an approval gate"
```

---

### Task 2: Unblock `validate-phase` and repoint it at the executable plan

**Files:**

- Modify: `.claude/skills/validate-phase/SKILL.md:13` (step 1, plan pointer)
- Modify: `.claude/skills/validate-phase/SKILL.md:16-18` (step 2, corrections-document pointer)
- Modify: `.claude/skills/validate-phase/SKILL.md:41-43` (`## Then stop` section)

**Interfaces:**

- Consumes: the six triggers from Task 1.
- Produces: `validate-phase` no longer terminates a run unconditionally. Task 3's GREEN definition calls this skill and relies on it returning a verdict rather than halting.

**Why this is in scope:** `validate-phase` currently ends with "Do not begin the next phase," which is the same rule Task 1 just replaced, expressed a second time. Left alone, autopilot halts at every phase boundary and the design does not function. Separately, steps 1–2 send the reader to `MVP_PLAN.md` (v2) and to the corrections document — both `[HISTORICAL]` per `CLAUDE.md`, so the Definition of Done being validated would be read from the wrong document, and Task 3's GREEN check would be built on it.

- [ ] **Step 1: Repoint step 1 of the procedure at v3**

Replace:

```markdown
1. **Read the phase's Definition of Done from `MVP_PLAN.md`.** Read it now, in full, from
   the document. Not from memory and not from the task list.
```

with:

```markdown
1. **Read the phase's Definition of Done from `MVP_PLAN_V3.md`.** Read it now, in full, from
   the document. Not from memory and not from the task list. `pnpm kb show phase <n>` prints
   that one section without spending a context window on the whole plan.
```

- [ ] **Step 2: Retire the corrections-document step**

Replace:

```markdown
2. **Check the corrections document** at
   `docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md` for deltas
   affecting this phase — §14 has a per-phase summary. Corrections win over the plan.
```

with:

```markdown
2. **There is no second document that wins on conflict.** v3 absorbed the corrections
   document and retired it. A comment citing a section number may be citing v2, whose numbers
   differ — resolve the citation against v3 before trusting it.
```

- [ ] **Step 3: Replace the unconditional stop**

Replace the whole final section:

```markdown
## Then stop

Do not begin the next phase. `MVP_PLAN.md` §8 and §96 both forbid it. Report and wait.
```

with:

```markdown
## Then hand the verdict back

Report the verdict. Do not advance on your own — this skill produces one input to GREEN, not
GREEN itself. `CLAUDE.md` `## Plan discipline` defines GREEN as gates, this verdict, expected
artifacts, and unresolved failure evidence all agreeing, and the caller checks all four.

Under `autopilot`, the caller advances on GREEN without asking. Outside it, report and wait.

Never soften a `NOT MET`. A phase reported complete at 90% is how the next phase inherits a
foundation nobody verified.
```

- [ ] **Step 4: Verify no unconditional stop and no historical citation remains**

Grep `.claude/skills/validate-phase/SKILL.md` for `MVP_PLAN.md` — expected: **zero** matches (`MVP_PLAN_V3.md` is a different string and must match once). Grep the same file for `Do not begin the next phase` — expected: **zero** matches.

- [ ] **Step 5: Confirm the harness gates still pass**

Run: `pnpm check:lanes` then `pnpm check:probes`

Expected: both exit 0. These read `.claude/` and must be unaffected by a skill-prose edit; a non-zero exit here means the edit broke something structural, not stylistic.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/validate-phase/SKILL.md
git commit -m "skills(validate-phase): return a verdict instead of halting; cite v3"
```

---

### Task 3: Add the `autopilot` skill and ignore its checkpoint file

**Files:**

- Create: `.claude/skills/autopilot/SKILL.md`
- Modify: `.gitignore` (append after line 15)

**Interfaces:**

- Consumes: the six triggers from Task 1; the non-halting `validate-phase` from Task 2.
- Produces: the checkpoint file contract at `.claude/autopilot.local.md` — YAML frontmatter with keys `phase`, `wave`, `step`, `charter`, and a `## Recovery log` body section. Nothing else in this repo reads that file; autopilot is both its only writer and its only reader.

- [ ] **Step 1: Ignore the checkpoint file before writing anything that creates it**

Append to `.gitignore`:

```gitignore

# Session-local agent state. `.claude/` is engineering infrastructure; a checkpoint recording
# one session's recovery attempts is not a fact about the repository.
.claude/*.local.md
```

Order matters: the ignore rule lands before the skill that tells a session to write the file, so a checkpoint can never be staged by accident.

- [ ] **Step 2: Verify the ignore rule matches**

Run: `git check-ignore -v .claude/autopilot.local.md`

Expected: prints `.gitignore:<line>:.claude/*.local.md	.claude/autopilot.local.md` and exits 0. An exit code of 1 with no output means the rule does not match — fix it before continuing.

Then run: `git status --porcelain .claude/`

Expected: no untracked `.local.md` entries. `.claude/settings.local.json` is a pre-existing tracked file and is out of scope — leave it exactly as it is.

- [ ] **Step 3: Create the skill directory and write the skill**

Create `.claude/skills/autopilot/SKILL.md` with this content, verbatim:

````markdown
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

Rows 2 and 3 are authoritative on completion. The checkpoint is authoritative on **recovery
history only** — it is the one fact with no other home. Where the checkpoint and `oracle`
disagree about what is done, `oracle` wins and the checkpoint is corrected.

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

For each phase:

1. **Frame** — `frame-phase`. Its own rule stands: a phase framed with one open decision
   remaining stops mid-wave. An open decision that the charter, `docs/decisions/` or the plan
   cannot settle is trigger 3 — ask, do not default it.
2. **Dispatch** — `pnpm lanes wave <phase>`, then the `dispatch-lanes` procedure verbatim.
   Read `execution_decision`; never re-derive it. Sequential is the default.
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
````

- [ ] **Step 4: Verify the skill is discoverable and well-formed**

Run: `pnpm kb search autopilot escalation`

Expected: hits including `.claude/skills/autopilot/SKILL.md` or `CLAUDE.md`. Then confirm the frontmatter parses: read the first 5 lines of `.claude/skills/autopilot/SKILL.md` and check that `name:` and `description:` are present between two `---` fences, matching the shape of `.claude/skills/dispatch-lanes/SKILL.md`.

- [ ] **Step 5: Confirm the repo still builds with the harness present**

Run: `pnpm gates`

Expected: exit 0. This plan touches only markdown, so a failure here is pre-existing and must be reported, not fixed inside this task.

- [ ] **Step 6: Confirm the repo still builds with the harness deleted**

Run: `pnpm check:isolation`

Expected: exit 0. `CLAUDE.md`: "LenGentic must run correctly if `.claude/` is deleted." A new skill directory must not change that, and this is the gate that proves it.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .claude/skills/autopilot/SKILL.md
git commit -m "skills: add autopilot — charter once, then advance on evidence"
```

---

### Task 4: Dry-run the skill against the live in-flight phase

**Files:**

- Create: `.artifacts/evidence/5a/autopilot-dryrun.md`
- Read only: `.claude/skills/autopilot/SKILL.md`, `.claude/autopilot.local.md`

**Interfaces:**

- Consumes: everything from Tasks 1–3.
- Produces: the evidence file that says whether the design works. Nothing consumes it downstream; it is the record.

**Why a dry run and not a unit test:** the deliverable is a procedure document, not executable code. The only honest validation is following it once against real state and recording what happened. The repository is mid-phase (5a, wave 3, `p5.det-candidate` not started), which makes it a genuine resume test rather than a synthetic one.

- [ ] **Step 1: Capture the true starting state, before autopilot touches anything**

Run and save the raw output of each:

```bash
pnpm oracle status
pnpm lanes wave 5a
git status --porcelain
```

Expected from `CLAUDE.md` `## Current state`: phase 5a, waves 1 and 2 landed, wave 3 not started, `p5.det-candidate` next. Record what the commands actually said, verbatim, including any disagreement with that expectation. A disagreement here is a finding, not a reason to edit the plan.

- [ ] **Step 2: Follow §1 of the skill and record where it resumes**

There is no `.claude/autopilot.local.md` yet, so resume falls through to `oracle`. Follow §1's table in order and write down the phase, wave and step it lands on.

Expected: phase `5a`, wave `3`, first incomplete action is **frame** for `p5.det-candidate`.

PASS criterion (a): it resumes at wave 3 and does **not** propose re-running wave 1 or wave 2.

- [ ] **Step 3: Follow §5 and record the trigger check**

Check all six triggers from `CLAUDE.md` against "dispatch `p5.det-candidate`". Write down each trigger and whether it fires, with one line of evidence.

Note `CLAUDE.md` `## Current state`: the threshold-binding spec sits in a path both wave-3 packets own, so `allowed_paths` cannot protect it, and `pnpm hash:5a before-<packet>` / `--compare` is required around each. Record whether that makes trigger 1 fire.

PASS criterion: the answer is reasoned from the charter and project rules, not from a coin flip. If any trigger fires, that is a **successful** dry run — stop there, report it, and record it as the outcome.

- [ ] **Step 4: Follow §3 and record the GREEN check against wave 2**

Wave 2 landed green at `a863346`. Run the four-source GREEN check in §3 against wave 2 and record each source's verdict with its evidence.

PASS criterion (c): all four sources are checked and reported separately. A run that reports "gates passed, so GREEN" has failed this step even if wave 2 is genuinely green.

- [ ] **Step 5: Verify the checkpoint round-trips**

Confirm `.claude/autopilot.local.md` now exists and matches the §1 shape. Then run:

```bash
git status --porcelain
```

Expected: `.claude/autopilot.local.md` does **not** appear. If it does, Task 3 Step 1 did not take effect — stop and fix it there.

- [ ] **Step 6: Write the evidence file**

Create `.artifacts/evidence/5a/autopilot-dryrun.md` containing, in order: the raw command output from Step 1; the resume verdict from Step 2 against PASS criterion (a); the six-trigger table from Step 3; the four-source GREEN table from Step 4; the checkpoint round-trip result from Step 5; and a final one-line verdict — **the design works**, or **it does not, because <reason>**.

Quote captured output verbatim. Trim only for length, and say where you cut.

- [ ] **Step 7: Report, do not advance**

Report the verdict to the human. Do **not** begin `p5.det-candidate` off the back of this dry run.

This is not a contradiction of the new rule. Autopilot advances through phases the human has already approved; it was never licensed to start real implementation work as a side effect of validating itself. Trigger 3 covers exactly this — whether to run autopilot for real on wave 3 is the human's call, and it has not been made.

`.artifacts/` is git-ignored, so there is nothing to commit for this task.

---

## Self-Review

**Spec coverage:**

| Spec requirement                                                           | Task                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| New skill `.claude/skills/autopilot/SKILL.md`                              | 3                                                  |
| Autopilot owns phase progression; `/loop` never orchestrates (amendment 1) | 3, skill preamble + §0                             |
| Step 0 charter via `grill-with-docs`                                       | 3, skill §0                                        |
| Resumable / idempotent, minimum checkpoint (amendment 2)                   | 3, skill §1 + Task 4 Step 2                        |
| Per-phase loop in fixed execution order                                    | 3, skill §2                                        |
| Two materially different recovery strategies (amendment 3)                 | 3, skill §4                                        |
| Evidence-backed GREEN, four sources agreeing (amendment 4)                 | 3, skill §3                                        |
| Six escalation triggers, trigger 3 worded as specified                     | 1                                                  |
| `CLAUDE.md` amendment, `agent-activation.json` untouched                   | 1 (Global Constraints forbid the edit)             |
| Dry-run validation against 5a wave 3                                       | 4                                                  |
| No new orchestration system                                                | Global Constraints; only one checkpoint file added |

Two files the spec did not name are edited: `.claude/skills/validate-phase/SKILL.md` (Task 2) and `.gitignore` (Task 3 Step 1). Both are prerequisites — the first holds a second copy of the rule being replaced, the second prevents session state from being committed. Neither adds capability.

**Placeholder scan:** No `TBD`, no "similar to Task N", no "add appropriate error handling". Every replacement shows both the exact text being replaced and the exact text replacing it. Every command states its expected result.

**Type consistency:** The checkpoint frontmatter keys (`phase`, `wave`, `step`, `charter`) and the `step` enum (`framed | dispatched | gated | validated | recovering`) are defined once in Task 3's Interfaces block and used identically in the skill body and in Task 4 Step 5. The four GREEN sources are named identically in the skill §3 table and Task 4 Step 4. The path `.claude/autopilot.local.md` is identical in `.gitignore`, the skill, and Tasks 3–4.
