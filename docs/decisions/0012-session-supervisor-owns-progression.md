---
number: 0012
title: The session supervisor owns progression; Claude sessions are disposable workers
date: 2026-08-21
status: accepted
---

# 0012 — The session supervisor owns progression; Claude sessions are disposable workers

- **Status:** accepted
- **Date:** 2026-08-21
- **Deciders:** human (session directive), Coordinator (recorded)
- **Supersedes nothing.** Extends `0011-autopilot-run-charter.md` with the mechanism that
  charter assumed a human would keep alive.

## Context

The `autopilot` skill already removes the approval gate between steps. It does not remove the
**session** gate. When a window filled up, the loop stopped in a way no tooling could resume:
write a handoff, ask the human for `/clear`, wait for them to come back. That is a human in the
loop for a reason that has nothing to do with the six escalation triggers — the run paused
because a context window ended, not because a decision was needed.

Everything needed to continue was already on disk. `pnpm flow next` derives the next action
from probes, gate records and lane handoffs; `pnpm oracle packet` slices a packet's whole
binding contract; `pnpm lanes decide` decides sequential-versus-parallel; `pnpm gates` decides
whether the code is good. The conversation was carrying nothing except _who was doing the
asking_.

## Decision

**A supervisor process, not a session, owns the run.** `pnpm autopilot` derives the next action
from the repository, launches a Claude worker to perform exactly that action, consumes the
worker's structured outcome, and launches the next one. A session may exit, run out of context,
crash or be killed at any moment; the run continues.

Four rules make that safe, and each has a regression scenario in `pnpm check:autopilot`.

### 1. The repository is the single source of truth; `.autopilot/` holds only what has no other home

`.autopilot/state.json` never caches completion. It holds repair-attempt counters, worker
session ids, unresolved failure evidence, the pending escalation, and the last green commit —
the facts nothing else records. Where it and the oracle disagree about what is done, the oracle
wins and the state file is corrected, exactly as `autopilot` §1 already says of the checkpoint.

A supervisor that cached "node X is DONE" would eventually advance a phase on its own memory.

### 2. Control flow is a file, never prose

A worker's only output that orchestration reads is one JSON envelope validated against
`.claude/rules/worker-outcome.schema.json`: `DONE | REPAIR_REQUIRED | BLOCKED | ROTATE |
FAILED`, with structured metadata. The derivation is asymmetric on purpose — no envelope means
`FAILED`, **including after a clean exit**. A worker can never become DONE by exiting quietly,
and no amount of confident output moves it there.

### 3. Progression is a total function over sources that must all agree

`scripts/autopilot/progression.ts` is `autopilot` §3 as code. A phase advances only when every
mandatory source is GREEN: nodes, gates, Definition of Done, artifacts, failure evidence.
UNKNOWN counts as RED. No single source may imply completion — 11/11 nodes with a red gate is
`HOLD_PHASE`, and the scenario that says so fails the moment anyone weakens it.

A gate is recorded only after the deterministic command exits 0 **and** the invariant holds,
and the record is written by `pnpm flow record`, which re-checks that every cited evidence path
exists. Claude is not one of the sources.

### 4. Rotation is a normal transition, not an interruption

Context pressure, a clean boundary, a crash and a timeout all resolve to "launch another worker
on the same task". The bounds are explicit: `--max-rotations` per node, `--max-repairs`
materially different repair strategies before trigger 5 fires. Only the six `CLAUDE.md`
triggers reach a human, and they arrive as a structured `AUTOPILOT_BLOCKED` record that
`pnpm autopilot resume --note "<decision>"` consumes.

## Consequences

- The manual workflow is untouched and remains the debugging path. `pnpm flow next`, `pnpm
lanes ...`, `pnpm gates`, `validate-phase` and every agent skill work exactly as before; the
  supervisor composes them rather than replacing them. `pnpm autopilot --dry-run` prints which
  it would run without launching anything.
- Workers run with `--permission-mode bypassPermissions` by default, because an autonomous run
  cannot pause on a permission dialog. `AUTOPILOT_PERMISSION_MODE` narrows it for anyone who
  wants a different posture. This is a real widening of what an unattended process may do on
  this machine, and it is the reason `pnpm autopilot doctor` exists and the reason the run is
  bounded by `--max-iterations`.
- Node ownership is a lease file per node, created with `wx`. Not a distributed lock: same
  machine, same filesystem, cooperating processes. A lease is stolen only when it is expired
  **and** its pid is gone; an expired lease held by a live process is a slow worker, not an
  abandoned node.
- `pnpm check:autopilot` stays out of `pnpm gates`, for the same reason `check:flow` and
  `check:lanes` are out: it reads `.claude/` and `.artifacts/`, and the product gate must keep
  working with the engineering harness deleted.
- The default repair bound is 2, per `CLAUDE.md` trigger 5. ADR 0011 raises it to three
  materially different strategies while that charter is in force; that is `--max-repairs 3`,
  passed deliberately rather than defaulted, so the narrower rule is what a bare `pnpm
autopilot` obeys.

## Alternatives rejected

**Keep the session as the driver and make handoffs better.** This is what the repository did.
It works right up to the point where the session that must write the handoff is the one that
ran out of room to write it. The failure mode is silent: a truncated brief reads like a
complete one.

**Let the worker decide what happens next and tell the supervisor.** Cheaper to build, and it
reintroduces exactly the thing `CLAUDE.md` ## Dispatch forbids — dispatch by judgement. It also
makes a false DONE unfalsifiable, because the actor claiming completion is the actor deciding
whether the claim is checked.

**A job queue / broker / daemon.** `CLAUDE.md` and the task both rule this out, and nothing here
needs it: one machine, one filesystem, a loop, and a lease file.

## Detection

- **A phase advances on one source.** `pnpm check:autopilot` scenario 4 walks every mandatory
  source alone and asserts `HOLD_PHASE`. If that scenario is ever weakened to "at least one
  GREEN", or a source is dropped from `PHASE_SOURCES` without a scenario changing, this record
  has been reversed in code while still reading as accepted.
- **A worker talks its way to DONE.** Scenario 15 spawns a real process that exits 0 printing
  "All done! Everything passed" and asserts `FAILED`. A run whose `journal.jsonl` shows
  `RUNNING -> DONE` for a worker with no envelope at `.autopilot/handoffs/<workerId>.json` is
  the failure this record exists to prevent.
- **A gate record outlives its proof.** Every record is written through `pnpm flow record`,
  which refuses evidence paths that do not exist. A `.artifacts/gates/*.json` whose `evidence`
  entries are missing means something wrote a record directly — check for a second writer.
- **Two workers on one node.** `.autopilot/leases/` holds at most one file per node while a run
  is live, and `pnpm autopilot doctor` reports any lease held by a dead pid. Two commits on one
  node id from two different `sessionId`s in the same journal window is the symptom.
- **The supervisor started deciding.** The moment `scripts/autopilot/` contains logic that
  chooses a phase, a wave or a packet without asking `pnpm flow next`, this is no longer a thin
  layer and `CLAUDE.md` ## Dispatch is being violated by the thing that was built to enforce
  it. `grep -rn "executionOrder\|segmentsOf" scripts/autopilot/` returning a hit outside a
  type import is the trigger to look.
