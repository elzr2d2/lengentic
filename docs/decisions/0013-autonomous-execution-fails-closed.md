---
number: 0013
title: Autonomous execution fails closed, and widening a safety bound must name its authority
date: 2026-08-21
status: accepted
---

## Context

`0012` made Claude sessions disposable and gave the supervisor the run. It shipped with
`--permission-mode bypassPermissions` as the default, on the reasoning that an unattended run
cannot pause on a permission dialog.

That reasoning is correct about dialogs and wrong about everything else. Bypass does not remove
a prompt; it removes **every** check. The supervisor's own escalation triggers — trigger 1
(destructive or hard to reverse) and trigger 4 (credentials, external cost, production,
security, privacy, legal) — became advisory the moment they were the only thing standing
between a worker and the operation, because the only enforcement left was a worker choosing to
report `BLOCKED` rather than proceed. An escalation class that depends on the actor to
self-report is not enforceable.

The same shape appeared in the repair bound. `CLAUDE.md` trigger 5 stops after **two**
materially different attempts; `0011` raised that to **three** for one charter's run. `0012`
documented the difference and left `--max-repairs` a plain number, so a run could be executing
under a charter written for a different run, indefinitely, with nothing on disk saying so.

Both are the same defect: **a safety bound that widens without anyone deciding to widen it.**

Measured, not assumed (`.artifacts/evidence/autopilot/permission-posture.md`):

- `--permission-mode auto` permitted `git push --force` in a scratch repository, despite
  shipping a `Git Destructive` soft-deny rule. It is a classifier, not a gate.
- A `permissions.deny` list supplied through `--settings` blocks a tool call deterministically
  in print mode, with no prompt and no human.
- `deny` beats `allow`, and beats the classifier's judgement.

## Decision

**Autonomous execution fails closed.** Two layers, each covering the other's failure mode:

```text
--permission-mode auto                          judgement — ordinary work proceeds unattended
--settings .claude/autopilot-permissions.json   floor — deny beats allow, beats the classifier
```

The floor denies one representative set per escalation class: credentials and secret stores,
production and cloud CLIs, external cost and publication, destructive or irreversible git and
filesystem and database operations, and — aimed at the supervisor itself — `.autopilot/`,
`.artifacts/gates/`, the floor file, and `pnpm flow record`. A worker that can forge a gate
record can manufacture a green.

`bypassPermissions` remains available and is not reachable by accident. It requires
`AUTOPILOT_PERMISSION_MODE=bypassPermissions` spelled exactly; a typo, a nonsense value, or a
mode a worker cannot act under is **refused before a worker exists** rather than falling back
to something permissive. A bypassed run is announced on the console, journalled at
`START -> RUNNING`, and written into `state.json`, so `pnpm autopilot status` can never show it
as an ordinary run.

**An attempt and a strategy are the same unit.** `autopilot` §4 already says so — "an attempt
is a materially different, evidence-driven strategy" — and `CLAUDE.md` trigger 5 uses the same
words. `0011` did not introduce a second unit; it raised the same count from 2 to 3, scoped to
one run, and added an obligation (a focused escalation analysis against its critical-blocker
definition). So there is nothing to model as a distinct concept, and inventing one would create
the ambiguity it was meant to remove.

What is modelled explicitly is the **bound and its authority**
(`scripts/autopilot/repair-policy.ts`). The default is 2, authorised by `CLAUDE.md` trigger 5.
A value above 2 must name the decision record that authorises it — `--charter <path>`, and the
path must resolve — or the run refuses to start, quoting trigger 5. Tightening needs no
authority; fewer attempts before asking a human is never the unsafe direction. The bound and
its authority are written to `state.json`, journalled before the first worker, shown by
`status`, and quoted in the trigger-5 escalation when the bound is finally reached.

## Consequences

- A supervised worker cannot read `.env` or `~/.ssh`, run a cloud CLI, publish, push, reset
  hard, `rm -rf`, or reset the database. If a packet genuinely needs one of those, the worker
  reports `BLOCKED` and a human decides — which is what triggers 1 and 4 always said should
  happen, now with something enforcing it.
- The floor is a **deterministic floor, not a proof of containment**. The matcher is
  prefix-based: `rm -rf` is denied, `rm --recursive --force` is not. Completeness is not
  claimed and must not be assumed; `auto` is the layer that covers what no list anticipated.
- `Bash(curl:*)` and a blanket `Bash(docker:*)` are deliberately absent. Phase 2's wave-2
  evidence booted the dashboard image and curled `/runs` on localhost, and Phase 7 owns a
  docker smoke test; denying them would break documented work. Exfiltration through either is
  what `auto`'s `Data Exfiltration` hard-deny is for.
- `auto` costs a classifier call per ambiguous tool use, and it is judgement — it will
  occasionally refuse something ordinary. The allow list exists to keep the gates, the tests and
  the commits off that path.
- A run under `0011` now reads `pnpm autopilot --max-repairs 3 --charter
docs/decisions/0011-autopilot-run-charter.md`. That is longer on purpose. The alternative was
  a flag whose meaning depended on a document nobody was required to cite.

## Detection

- **The default drifted back open.** `pnpm check:autopilot` scenario 41 asserts the resolved
  default is neither `bypassPermissions` nor flagged bypassed, and that a default argv carries
  `--settings`. Scenario 42 asserts a typo does not resolve to bypass. Both were mutation-probed
  (`mutation-probes-safety.md`); if either is ever weakened to "some mode is set", the default
  can move without a failing test.
- **A class lost its last rule.** Scenario 43 walks one representative per escalation class and
  fails when none of the floor's deny rules covers it. A rule renamed is fine; a class left with
  nothing is not.
- **A run was widened and nobody knows.** `pnpm autopilot status` prints `Repair bound` with its
  authority, and `.autopilot/journal.jsonl` carries it at `START -> RUNNING`. A trigger-5
  escalation whose reason does not quote a bound came from a build where scenario 47 was
  removed.
- **A bypassed run reads as an ordinary one.** `state.permissionBypassed` and the console
  WARNING are the signal. A `.autopilot/state.json` with `permissionMode: "bypassPermissions"`
  and no corresponding line in the run's journal means the recording path was bypassed too.
- **The floor stopped being enforced.** The live check is probe 4 in
  `permission-posture.md`: attempt `env`, a `.env` read, an `rm -rf`, and `pnpm flow record`
  under the shipped argv, and confirm all four are REFUSED while `git status` runs. If
  `.artifacts/gates/` ever gains a record no supervisor run wrote, a worker got through.
