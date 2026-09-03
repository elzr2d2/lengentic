---
number: 0011
title: Autopilot run charter — standing preferences for the phase 2 to 7 run
date: 2026-08-21
status: accepted
---

# 0011 — Autopilot run charter: standing preferences for the phase 2 → 7 run

- **Status:** accepted
- **Date:** 2026-08-21
- **Deciders:** human (session directive), Coordinator (recorded)

## Context

The human opened an autopilot run with an explicit, written directive covering the whole
remaining roadmap (`0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`, resuming mid-phase-2). The
directive is a charter: it states the objective and a set of standing preferences that
`CLAUDE.md` trigger 3 would otherwise force the session to ask about, repeatedly.

`autopilot` §0 requires the charter be landed as a decision record before the first
dispatch, precisely so those preferences are inferable later instead of re-asked. Grilling
was not run: the directive already answers what grilling would have asked, and it forbids
asking about equivalent implementation details.

## Decision

**Objective.** Carry every remaining roadmap packet through Phase 7 to GREEN by the four
sources in `autopilot` §3, without per-phase approval.

**Standing preferences, binding for this run:**

1. **Default is CONTINUE, not ASK.** A red test, a failing gate, a flaky test, a merge
   conflict, an integration mismatch, or a single spent repair attempt is normal work.
   Investigate → repair → prove → continue.

2. **The two-attempt bound is replaced, not removed.** After two spent attempts, re-diagnose
   from evidence and try a _materially different_ strategy. Escalate only when one root cause
   survives **three materially different** strategies, and then only after a focused
   escalation analysis that tests it against the critical-blocker definition below.
   Difficulty alone is never critical.

3. **The six `CLAUDE.md` triggers are narrowed for this run to these critical blockers:**
   data integrity (irreversible loss, unrepairable persisted state, silent corruption via an
   idempotency/concurrency flaw); security/privacy (authz bypass, secret exposure, trust
   boundary); core correctness (green that lies, forgeable evidence, an unmaintainable
   foundational invariant); architecture (a fix that contradicts an accepted ADR or changes a
   major public contract, or a hard-to-reverse decision the docs do not already imply);
   destructive/external (production, credentials, paid resources, destructive migration,
   legal); and a proven dead end per (2).

4. **Equivalent implementation details are the Coordinator's to decide.** Record the
   assumption in the handoff or the checkpoint; do not ask.

5. **Green that lies is failure.** Never weaken an assertion, delete a meaningful test,
   broaden a tolerance, add a retry, mock away the behaviour under test, or edit an expected
   value to obtain green. Where practical, prove a protection by breaking it deliberately and
   watching the test go red.

6. **Bug loop is fixed:** REPRODUCE → CLASSIFY → ROOT CAUSE → FIX → REGRESSION TEST →
   NEGATIVE PROOF → GATES → CONTINUE. Bugs found on the current execution path are fixed
   even when unlisted, provided the fix does not change approved scope. Unrelated
   non-critical debt goes to `BACKLOG.md` and the run continues.

7. **Scope discipline is unchanged.** Roadmap requirements, the infrastructure they require,
   correctness fixes, and the evidence that proves them. No opportunistic refactoring.
   Smallest safe change.

8. **A builder is never the sole authority on its own work.** Validator at the wave gate,
   reviewer and tester at the phase gate, per the printed `review_cadence`. Use a fresh
   context for important gates.

## Consequences

- Trigger 3 ("no preference can be safely inferred") is answerable from this record for the
  rest of the run. A question whose answer is above is decided, not asked.
- The escalation bar is _higher_ than `CLAUDE.md`'s default, and deliberately so; this record
  is scoped to this run and does not amend `CLAUDE.md`.
- Autopilot's §4 "two attempts then trigger 5" is superseded for this run by preference (2).
  The checkpoint's recovery log still records every attempt, so the count is auditable.

## Alternatives rejected

- **Run `grill-with-docs` anyway.** The directive forbids asking about equivalent
  implementation details and is already explicit on objective, repair policy and stop
  conditions. Grilling would have produced this same record at the cost of the thing the
  directive most wants preserved: forward motion.
- **Treat the directive as conversational context only.** It would then be invisible to the
  next session and to every subagent, and trigger 3 would fire on questions the human has
  already answered in writing.

## Detection

- **The record was never indexed.** `pnpm check:decide` threw on this file — first for absent
  front matter, then for this missing section — from the moment it was written until
  2026-08-21. A charter the ADR index cannot parse is invisible to `pnpm decide ask`, which is
  the one command a session runs to find out whether a question is already answered. If that
  command starts returning NOVEL for a question preference (1)-(7) answers, this record has
  drifted out of the index again.
- **The bar was raised and nobody noticed.** Preference (2) replaces autopilot §4's two-attempt
  bound with three materially different strategies. `pnpm autopilot` defaults to two, so a run
  under this charter must pass `--max-repairs 3` explicitly. An escalation on trigger 5 after
  exactly two attempts is the visible symptom that the charter was not applied.
- **The narrowing outlived the run.** Preference (3) narrows the six `CLAUDE.md` triggers for
  THIS run only. If a session after the run cites this record to decline an escalation
  `CLAUDE.md` requires, the scoping in Consequences was read as permanent and this record needs
  superseding rather than quoting.

## Addendum — 2026-09-03: the `/goal` run is bounded at the end of Phase 5

The human reopened the run with `/goal proceed until phase 4 and 5 are completed`. That
narrows the objective and nothing else; preferences (1)-(8) above are unchanged and still
binding.

- **Stop condition for this run.** Not `pnpm flow next` returning `COMPLETE`, but the Phase 5
  phase gate recorded GREEN. In the amended execution order (`0 → 1 → 5a → 2 → 3 → 4 → 5b →
6 → 7`) that is: finish Phase 4's last packet, then Phase 5 waves 4-6 (`5b`). Phases 6 and 7
  are out of scope for this run.
- **How it is enforced.** `pnpm autopilot` has no `--until-phase`; the Coordinator monitors and
  issues `pnpm autopilot stop` once the Phase 5 gate record exists and is GREEN. A supervisor
  that reaches Phase 6 before the stop lands is not a violation — it stops at its next safe
  point and Phase 6 work is reverted or abandoned, not merged.
- **The stale escalation of 2026-08-31 is resolved, not overridden.** It held segment 4's wave
  gate over `p4.read-model / p4.run-summary / p4.sdk-decisions` on a Reviewer CHANGES REQUESTED
  plus an undecidable DoD checkbox 6. Both are closed on disk: the gate is recorded at
  `.artifacts/gates/wave-4-p4-read-model-p4-run-summary-p4-sdk-decisions.json` (2026-09-01), two
  later segment-4 wave gates have recorded since, and checkbox 6's wire gap was decided the way
  the envelope's first option proposed — commit `49c7fb0` cut `p4.sdk-drop-reporting`
  (batch-level `droppedSinceLastBatch`). The escalation counter also mis-attributed two wave-1
  attempts to the wave-2 gate, which the gate worker's own envelope states.
- **`--max-repairs 3` is passed, naming this record.** Its Detection section predicted the exact
  failure of not doing so.

### Detection (addendum)

- **The bound was ignored.** If the supervisor records a Phase 6 packet as DONE, the stop was
  never issued and this addendum's objective was read as the standing one.
