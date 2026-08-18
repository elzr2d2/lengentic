# Autopilot Workflow — Bounded-Autonomy Session Loop

**Date:** 2026-08-17
**Status:** Accepted (pending spec review)
**Applies to:** `.claude/skills/` (new skill), `CLAUDE.md` (amendment)

## Problem

The user wants a single entry point that (1) captures session objective and preferences
once via `grill-with-docs`, then (2) drives development phase-to-phase without being asked
to approve every routine step. Today `CLAUDE.md` forbids this outright: "Never automatically
begin the next MVP phase," and every phase transition is an implicit human-approval gate.

The user does not want the "no coordinator agent" rule touched. They want the existing
approval _gate_ replaced by a narrower set of _escalation triggers_, everything else
proceeding on evidence.

## Non-goals

- No new dispatch mechanism. `pnpm lanes wave` / `dispatch-lanes` remain the only way work is
  parallelised or serialised.
- No coordinator subagent. The main session is still the only thing that decides what runs
  next (`agent-activation.json` §controlPlane, unchanged).
- No literal use of the `ralph-loop` plugin. It reruns one fixed prompt via a Stop hook; it
  cannot sequence distinct skills (frame-phase → dispatch-lanes → gates → validate-phase).
  Its "N attempts then stop" _idea_ is reused; the plugin itself is not.
- No new orchestration engine, task queue, or state machine framework. One small checkpoint
  file, described below, is the only new persistent state.

## Design

### 1. New skill: `.claude/skills/autopilot/SKILL.md`

Procedure-only, same shape as `dispatch-lanes` and `frame-phase` — the main session reads it
and executes it directly. Autopilot **owns** phase progression and every dispatch decision.
`/loop` (the existing self-pacing skill) may be used underneath it purely to re-invoke the
session across turns when the human isn't typing; `/loop` never makes an orchestration or
phase decision itself, it only wakes the session up to run the next autopilot iteration.

**Step 0 — Charter (once per autopilot invocation).**
Run `grill-with-docs` (→ `grilling` + `domain-modeling`). Output: ADRs/glossary entries
capturing objective and standing preferences for this engagement. This is the material
escalation trigger #3 checks against — a preference captured here is "inferable," not
"ask the human."

**Step 1 — Resume, don't restart.**
Before any dispatch, read state from disk, in this order, and act on the first incomplete
point found:

1. `.claude/autopilot.local.md` (new, git-ignored, same convention as
   `.claude/ralph-loop.local.md`) — current phase, current wave, current step
   (`framed | dispatched | gated | validated | recovering`), and the recovery log for the
   step in progress (strategies already tried + their evidence).
2. `pnpm oracle status` / `pnpm lanes wave <phase>` — authoritative wave/lane completion
   state. Autopilot never duplicates this; it only points at a phase/wave to ask about.
3. `.artifacts/handoffs/*.json` — lane-level DONE/BLOCKED evidence already on disk.

This is the only new checkpoint file. It exists because recovery-attempt history (which
strategy was tried, with what evidence) has no other home — everything else above it is
already tracked by `oracle`/`lanes`/handoffs and must be read, not re-derived.

**Step 2 — Per-phase loop**, walking `MVP_PLAN_V3.md`'s fixed execution order
(`0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`) starting at the first incomplete phase:

1. `frame-phase` — surface and settle open decisions for this phase.
2. `pnpm lanes wave <phase>` → `dispatch-lanes` procedure verbatim (sequential-by-default,
   agent chain from `agent-activation.json`, worktrees, packet dispatch, per-lane gates).
3. Gate check (see "GREEN definition" below).
4. GREEN and phase DoD met → advance to the next phase immediately, no permission asked,
   _unless_ starting the next phase would itself trip trigger 2 or 3 (checked before
   advancing, not after).
5. Update `.claude/autopilot.local.md` at each step boundary.

**Step 3 — Bounded recovery**, entered on any gate failure:

Two attempts, and "attempt" means a materially different, evidence-driven strategy — not a
retry of the same fix:

```
attempt N (N = 1, 2):
  Diagnose      → diagnostician, from BLOCKED not from a guessed FAILED cause
  Targeted fix  → builder applies a fix scoped to that diagnosed cause
  Targeted validate → the narrowest command that exercises just this fix
  if narrow validation fails: this attempt is spent; attempt N+1 must pick a
    different diagnosis or a different fix strategy, not repeat this one
  if narrow validation passes: re-run the required gate (full GREEN check)
```

Both attempts exhausted without a full GREEN → trigger 5 fires. Stop, report `BLOCKED` with
both attempts' evidence (`dispatch-lanes` §7 shape), ask the human.

**GREEN definition** (used at every phase-boundary check and every recovery attempt's final
gate): all of the following must agree, not any one alone:

- Required gates (`pnpm gates`, or the packet's `validate` commands) exit 0.
- `validate-phase` confirms the Definition of Done against real output.
- Expected artifacts for the phase/wave exist on disk.
- No unresolved failure evidence (a prior red that was never explained) contradicts the above.

An agent's self-report or a bare exit code is never sufficient by itself — this restates
`CLAUDE.md`'s existing "DONE is a claim about evidence" standard, applied to phase transitions
too.

### 2. Escalation triggers (stop and ask, always, no exceptions)

1. The action is destructive or hard to reverse.
2. It changes approved product scope or architecture materially.
3. High-impact decision where no preference can be safely inferred from project rules, ADRs,
   prior decisions, or the approved plan.
4. Credentials, external cost, production systems, security/privacy, or legal/compliance are
   involved.
5. A required gate fails and two materially different, evidence-driven recovery attempts have
   both failed.
6. Requirements genuinely conflict and choosing one would invalidate another.

Checked _before_ every dispatch and every phase advance, not only on failure.

### 3. `CLAUDE.md` amendment

In `## Plan discipline`, replace the single line:

> Never automatically begin the next MVP phase.

with the bounded-autonomy paragraph and the six triggers above (full text in the
implementation plan). `## Agents` → "The main session is the Coordinator. There is no
coordinator agent." is **not** touched — autopilot is a skill the main session follows, not
an agent, and every dispatch still routes through `pnpm lanes wave`.

## Data flow

```
human → grill-with-docs → ADRs/glossary (charter)
                              │
                              ▼
        ┌── autopilot: read .claude/autopilot.local.md + oracle status ──┐
        │                                                                 │
        ▼                                                                 │
   frame-phase → pnpm lanes wave → dispatch-lanes → gates ── RED ──► bounded
        ▲                                            │                recovery
        │                                          GREEN                 │
        │                                            │           2 strategies
        └──────────────── next phase ◄────────────────           exhausted, still RED
                                                                          │
                                                                          ▼
                                                                trigger 5 → ask human
```

## Error handling

Covered above (bounded recovery, escalation triggers). No new error class beyond what
`dispatch-lanes` §7 and `validate-phase` already define — this reuses their vocabulary
(`BLOCKED`, `unverified`) rather than inventing a parallel one.

## Testing / validation

This is a procedure document plus one small state-file convention, not executable code.
Validation is a dry run: invoke `/autopilot` on the current in-flight phase (5a, wave 3,
`p5.det-candidate`), confirm it (a) resumes from the correct wave without re-running
completed work, (b) reaches a real GREEN or a real trigger-5 escalation, and (c) never
advances past a phase boundary without the GREEN definition being met.

## Open questions

None — scope is fixed to what was approved; further ideas go to `BACKLOG.md`.
