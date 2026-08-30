---
name: goal
description: Run the approved roadmap to completion — start the autopilot supervisor and keep it running until `pnpm flow next` returns COMPLETE (Phase 7 gate GREEN), escalating only on the six triggers. Use when the human types /goal or asks to "run to the goal".
---

# Goal

One trigger, one stop condition. `/goal` means: proceed through the remaining approved
phases (`3-repair → 4 → 5b → 6 → 7` per `.artifacts/plans/roadmap-2026-08-30.md`) without
per-step approval, until `pnpm flow next` returns `COMPLETE`. The delivery loop itself is
the `autopilot` skill; the unattended mechanism is `pnpm autopilot`. This skill adds only
the trigger and the finish line — it restates neither.

## Procedure

1. **Charter.** `docs/decisions/0011-autopilot-run-charter.md` is the standing charter.
   If the human's `/goal` message adds constraints, append them to the charter record
   before the first dispatch; otherwise touch nothing.
2. **Preflight.** `pnpm autopilot status` — if a supervisor is already running, monitor it
   instead of starting a second one. `pnpm autopilot doctor` if status looks wrong. A
   pending stop request is cleared by the next `pnpm autopilot` start.
3. **Start.** Run `pnpm autopilot` in the background. It owns progression (decision 0012);
   do not run a parallel manual loop in this session.
4. **Monitor.** Check `pnpm autopilot status` at long intervals. Relay to the human:
   every phase-gate verdict (GREEN/RED, evidence paths), every escalation, and nothing
   per-packet. Silence between gates is correct behavior.
5. **Escalation.** The six CLAUDE.md triggers stop the run and reach the human — that is
   the supervisor's job, backed by the deny floor. When one fires, present it with its
   evidence and wait; resume with `pnpm autopilot resume --note "<decision>"`.
6. **Finish.** When `pnpm flow next` returns `COMPLETE`: report the final phase-gate
   evidence paths, confirm the repo is runnable (`pnpm gates:full` from the last gate
   record, not re-run), and stop. `/goal` never redefines the goal — DoD is
   `MVP_PLAN_V3.md`, progress is the oracle.

## Not this skill

- Debugging a stuck run — that is the `autopilot` skill's manual loop.
- Changing scope, plan, or phase order — trigger 2/3, human decision.
- `pnpm autopilot stop` at the human's request needs no skill.
