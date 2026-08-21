# The autopilot session supervisor

`pnpm autopilot` carries the repository from its current durable state to the next genuine
human-decision boundary, across any number of Claude sessions, without user involvement.

It is a thin layer. It decides nothing that the existing tooling already decides — it asks, in
order, and acts on what comes back.

```text
pnpm flow next          what happens next          (probes, gate records, lane handoffs)
action.mode             sequential or parallel     (pnpm lanes decide, via flow)
pnpm oracle packet      what this packet is        (fetched by the worker, not inlined)
pnpm gates              is the code good           (run by the supervisor, not a worker)
progression.ts          may the phase advance      (the invariant, as a total function)
pnpm flow record        write the gate record      (re-checks that the evidence exists)
```

The design decision and the alternatives are `docs/decisions/0012-session-supervisor-owns-progression.md`.
The manual procedure the supervisor automates is `.claude/skills/autopilot/SKILL.md`, and it
still works by hand — that is the debugging path, and it is not deprecated.

---

## 1. Commands

```bash
pnpm autopilot                        # run until COMPLETE, an escalation, or a stop
pnpm autopilot --dry-run              # derive and print the next action; launch nothing
pnpm autopilot status                 # the derived truth right now, from disk
pnpm autopilot doctor                 # can this machine run a supervised session at all
pnpm autopilot stop                   # ask a running supervisor to stop at its next safe point
pnpm autopilot resume --note "<...>"  # record a human decision and continue past an escalation
pnpm check:autopilot                  # the supervisor's own scenarios (CI; not in `pnpm gates`)
```

Run bounds, all overridable per invocation:

| Flag                   | Default | What it bounds                                                |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `--max-iterations <n>` | 200     | loop iterations before the supervisor returns                 |
| `--max-repairs <n>`    | 2       | materially different repair strategies before trigger 5 fires |
| `--max-rotations <n>`  | 8       | rotations on one node before one repair attempt is charged    |
| `--concurrency <n>`    | 3       | workers in flight when the lane decision says parallel        |
| `--worker-timeout-min` | 90      | wall clock for one worker before it is killed and classified  |

`--max-repairs` defaults to 2 because that is `CLAUDE.md` trigger 5. ADR 0011 raises it to three
materially different strategies while that charter is in force — pass `--max-repairs 3`
deliberately; a bare `pnpm autopilot` obeys the narrower rule.

Exit codes: `0` the run finished or stopped cleanly, `2` a human decision is required, `1` the
supervisor itself failed.

---

## 2. What is durable, and what is not

**The repository is the single source of truth for what is done.** Git, the oracle's probes,
`.artifacts/gates/`, `.artifacts/handoffs/`. `pnpm flow next` reads exactly those.

`.autopilot/` holds only the facts with no other home:

```text
.autopilot/
  state.json            repair counters, worker sessions, unresolved failures, escalation,
                        last green commit — atomic writes, revision-checked
  journal.jsonl         append-only: every state transition, with its evidence paths
  leases/<node>.json    one live owner per node
  sessions/<worker>/    brief.md, stdout.log, stderr.log — one directory per worker
  handoffs/<worker>.json  the worker's outcome envelope
  escalations/*.md      the AUTOPILOT_BLOCKED record a human reads
  stop                  a stop request, as a file, so it survives a crash
```

Evidence does **not** live there. Gate command output, verdict summaries and everything a gate
record cites go to `.artifacts/evidence/autopilot/<runId>/`, alongside every other artifact in
this repository. `.autopilot/` is gitignored: it names pids and session ids on one machine.

Where `state.json` and the oracle disagree about completion, **the oracle wins** and the state
file is corrected. That is the same rule `autopilot` §1 already applies to the checkpoint, and
it is why a supervisor restart cannot resurrect a stale belief.

---

## 3. The worker contract

A worker is a `claude --print` process handed one task on stdin. Before it exits it writes one
JSON file matching `.claude/rules/worker-outcome.schema.json`:

| Outcome           | Means                                                        | Supervisor does                                         |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `DONE`            | task finished, evidence on disk                              | re-derives from the repository; never takes it on trust |
| `REPAIR_REQUIRED` | a real, diagnosable failure                                  | charges one repair attempt, redispatches as `repair`    |
| `ROTATE`          | out of context, or a clean boundary                          | launches a fresh worker on the same task                |
| `BLOCKED`         | a `CLAUDE.md` trigger fired (`trigger` + `options` required) | stops and escalates                                     |
| `FAILED`          | could not complete, could not classify                       | charges one repair attempt, relaunches                  |

The derivation is asymmetric on purpose:

```text
valid envelope        -> the outcome it states
no envelope, exit 0   -> FAILED
no envelope, exit ≠ 0 -> FAILED
killed on timeout     -> FAILED
```

**A worker can never become DONE by exiting quietly**, and no amount of confident prose moves it
there. Nothing a worker prints is parsed for control flow. Scenario 15 in `pnpm check:autopilot`
is the regression: a fixture that exits 0 printing "All done! Everything passed" is `FAILED`.

The brief goes down stdin rather than onto the command line — it is multi-kilobyte Markdown, and
Windows resolves `claude` through a `.cmd` shim that needs a shell.

---

## 4. Progression — the invariant

`scripts/autopilot/progression.ts` is `autopilot` §3 as a total function. A **phase** advances
only when all five mandatory sources are GREEN:

| Source             | Derived from                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `nodes`            | `pnpm oracle status` exit 0, re-probed at gate time — not inherited from the action |
| `gates`            | `pnpm gates:full` exit 0, captured to an evidence log                               |
| `definitionOfDone` | the phase-gate worker's `validate-phase` artifact, **checked mechanically**         |
| `artifacts`        | every evidence path the record will cite exists and is non-empty                    |
| `failureEvidence`  | no unresolved blocking failure recorded for this run                                |

A **wave** gate uses the narrower set — `nodes`, `gates`, `validation`, `failureEvidence` — because
the Definition of Done is a phase-level contract and is not re-adjudicated per wave.

Two properties hold and are regression-tested:

- **UNKNOWN is RED.** A source nobody measured has not passed.
- **No single source may imply completion.** 11/11 nodes with a red gate is `HOLD_PHASE`.

The Definition-of-Done artifact is not accepted on the worker's word: `checkDodArtifact` requires
at least one bound checkbox, zero unchecked boxes, and none of `NOT MET`, `UNVERIFIED`,
`deferred`, `skipped`. Deferred, skipped and unknown are all unverified.

When the deterministic gate command is RED, **no gate worker is launched at all** — the agent
tokens are not spent on a gate that cannot pass, and the record cannot be written however many
nodes are DONE.

---

## 5. Rotation, repair, escalation

```text
worker outcome           supervisor
──────────────────────   ─────────────────────────────────────────────────────────────
ROTATE                   launches a fresh worker on the same task, same node
                         after --max-rotations, charges one repair attempt
REPAIR_REQUIRED/FAILED   charges one repair attempt, node -> REPAIR, redispatch as `repair`
                         after --max-repairs, escalates on trigger 5
BLOCKED                  escalates on the worker's own trigger, with its options and evidence
same action N times      escalates on trigger 5 as "the run is stuck" (--no-progress guard)
```

Nothing on that list reaches a human except the last two. A failing test, a red lint, a broken
build, an ordinary bug, a resolvable merge conflict, a crashed worker, an exhausted context or
thin-but-strengthenable evidence are all ordinary work.

An escalation is a structured record, not a sentence:

```text
AUTOPILOT_BLOCKED

phase: 4
node: p4.entities
trigger: 3
reason: ...

options:
A: ...
B: ...

evidence:
  .artifacts/evidence/autopilot/<runId>/...
```

`pnpm autopilot resume --note "<the decision>"` records the resolution and continues from
durable state. Until then the run mutates nothing further — including across a restart, because
the escalation is in `state.json`.

---

## 6. Concurrency

When `pnpm flow next` returns `mode: parallel`, up to `--concurrency` workers run at once, one
per packet. Ownership is a lease file per node, created with `wx` — the filesystem decides who
wins a race, not the code above it.

A lease is stolen only when it is expired **and** its pid is gone. An expired lease held by a
live process is a slow worker, not an abandoned node, and stealing it is the duplicate-ownership
bug the lease exists to prevent. A node already leased is skipped and journalled, never
double-dispatched.

This is not a scheduler. Same machine, same filesystem, cooperating processes.

---

## 7. Failure modes and what recovers them

| Failure                        | Recovery                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| worker exits mid-node          | classified FAILED, relaunched; lease released in `finally`       |
| worker hangs                   | killed at `--worker-timeout-min`, classified FAILED, relaunched  |
| worker runs out of context     | writes ROTATE + a continuation brief; a fresh worker continues   |
| worker dies holding a lease    | reaped on the next iteration once its pid is proven gone         |
| supervisor exits               | `pnpm autopilot` again: same run id, same counters, from disk    |
| supervisor is killed mid-write | writes are temp-file + rename; a partial file is never observed  |
| two supervisors race a write   | the stale write is refused (`StaleStateError`), never clobbered  |
| state.json is corrupt          | a hard error — silently restarting would reset the repair bounds |

`pnpm autopilot doctor` checks the preconditions before a run: the CLI is present, the schema is
wired, `flow` derives a non-ERROR action, state is readable, no lease is held by a dead pid.

---

## 8. Safety posture

Workers run with `--permission-mode bypassPermissions` by default, because an unattended run
cannot pause on a permission dialog. `AUTOPILOT_PERMISSION_MODE` narrows it. That is a real
widening of what a background process may do on this machine — the loop is bounded by
`--max-iterations`, every worker is bounded by `--worker-timeout-min`, `pnpm autopilot stop`
halts a run at its next safe point, and `--dry-run` shows exactly what would happen first.

Environment seams:

| Variable                    | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `AUTOPILOT_CLAUDE_BIN`      | the Claude executable (default `claude`)             |
| `AUTOPILOT_PERMISSION_MODE` | passed to `--permission-mode`                        |
| `AUTOPILOT_WORKER_CMD`      | replaces the launcher entirely — the scenarios' seam |
| `AUTOPILOT_WORKER_ARGS`     | arguments for that launcher, space-separated         |

---

## 9. Backward compatibility

Nothing was removed. `pnpm flow next`, `pnpm lanes ...`, `pnpm oracle ...`, `pnpm gates`,
`validate-phase`, the `.claude/skills/*` procedures and the `.artifacts/` evidence layout are
unchanged, and the supervisor calls them rather than reimplementing them. Driving the loop by
hand from `.claude/skills/autopilot/SKILL.md` still works and is the right thing to do when the
question is "why did it do that".
