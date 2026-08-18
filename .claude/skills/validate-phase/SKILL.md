---
name: validate-phase
description: Verify a phase's Definition of Done is genuinely met before declaring it complete or moving on. Use when a phase looks finished, or before starting the next one.
---

# Validate Phase

A phase is complete when its Definition of Done is met — not when the tasks are ticked. The
two diverge more often than anyone expects.

## Procedure

1. **Read the phase's Definition of Done from `MVP_PLAN_V3.md`.** Read it now, in full, from
   the document. Not from memory and not from the task list. `pnpm kb show phase <n>` prints
   that one section without spending a context window on the whole plan.

2. **There is no second document that wins on conflict.** v3 absorbed the corrections
   document and retired it. A comment citing a section number may be citing v2, whose numbers
   differ — resolve the citation against v3 before trusting it.

3. **Take each checkbox one at a time and produce evidence.** For each, one of:
   - a command you ran and its real output, or
   - a file path and line that satisfies it, or
   - `NOT MET`, with what is missing.

   A checkbox with no evidence is not met. "It should work" is not evidence.

4. **Run `pnpm gates:full`.** Every phase's DoD includes leaving the repository runnable.

5. **Check for scope leakage in both directions.** Work that belongs to a later phase is a
   finding — it inflates the current phase and pre-commits decisions the later phase should
   own. Work quietly dropped from this phase is a worse finding.

## Report

State met / not met per checkbox with its evidence. Then one line: is this phase complete?

If any checkbox is not met, the phase is not complete. Say that plainly rather than
qualifying it — a phase reported complete at 90% is how the next phase inherits a
foundation nobody verified.

## Then hand the verdict back

Report the verdict. Do not advance on your own — this skill produces one input to GREEN, not
GREEN itself. `CLAUDE.md` `## Plan discipline` defines GREEN as gates, this verdict, expected
artifacts, and unresolved failure evidence all agreeing, and the caller checks all four.

Under `autopilot`, the caller advances on GREEN without asking. Outside it, report and wait.

Never soften a `NOT MET`. A phase reported complete at 90% is how the next phase inherits a
foundation nobody verified.
