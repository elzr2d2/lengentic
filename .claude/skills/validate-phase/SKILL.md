---
name: validate-phase
description: Verify a phase's Definition of Done is genuinely met before declaring it complete or moving on. Use when a phase looks finished, or before starting the next one.
---

# Validate Phase

A phase is complete when its Definition of Done is met — not when the tasks are ticked. The
two diverge more often than anyone expects.

## Procedure

1. **Read the phase's Definition of Done from `MVP_PLAN.md`.** Read it now, in full, from
   the document. Not from memory and not from the task list.

2. **Check the corrections document** at
   `docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md` for deltas
   affecting this phase — §14 has a per-phase summary. Corrections win over the plan.

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

## Then stop

Do not begin the next phase. `MVP_PLAN.md` §8 and §96 both forbid it. Report and wait.
