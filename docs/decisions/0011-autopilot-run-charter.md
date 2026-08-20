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
