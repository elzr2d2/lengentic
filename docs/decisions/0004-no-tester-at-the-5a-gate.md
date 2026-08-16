---
number: 0004
title: Tester does not run at the Phase 5a gate; a threshold-binding spec runs instead
date: 2026-08-16
status: accepted
---

## Context

`.claude/rules/agent-activation.json` classes Phase 5a's fixture and analyzer packets as
`behavior`, which lists `adversarial-test` as **required**, and resolves that capability
preference-ordered:

> `"adversarial-test": ["tester", "validator"]`

Both agent files exist, so the capability resolves to `tester`. Read mechanically, Tester is
required at the 5a gate.

`.claude/agents/tester.md` describes a different job from the one 5a offers. Its stated edge
is independent falsification against **the real running system** in a fresh session — the
value is in attacking a live surface with inputs nobody designed for. Phase 5a has no running
system by construction: no database, no HTTP, no SDK, no UI, no Docker. It is pure functions
over JSON fixtures.

Stripped of a running system, the adversarial job on 5a reduces to one concrete question:
_does each gate threshold actually bind?_ Shift `minSampleCount` from 30 to 31 and `D1` must
flip to `SUPPRESSED`; shift it to 29 and `D5` must not. That is a loop over five thresholds
and fifteen fixtures with a deterministic expected result for every cell.

`CLAUDE.md` already rules on that shape:

> Mechanical checks are tooling, not agents. Never ask an agent to verify something a script
> can verify.

The two rules point opposite ways. This record resolves the conflict rather than leaving a
future session to rediscover it and guess.

### The position this overturns

`BACKLOG.md`, "Council findings deferred out of 5a", says the opposite in as many words:

> **Trigger:** the 5a gate — 5a _is_ a phase gate, and it is the thesis-critical one, so
> Tester running there is the intended case rather than the cost problem.

That entry is answering a **different** question and is correct on it. The council's finding
was that Tester was scheduled on _every_ behavior-class wave, which is a cost problem, and the
entry's fix is to pin Tester to phase gates. Against that framing, 5a being a phase gate makes
it the intended case.

What the entry does not weigh is whether 5a's gate has a surface Tester can attack. It has
none. The disagreement is therefore about the premise, not the policy: "pin Tester to phase
gates" survives this record intact and applies from 5b onward. 5a is an exception on a ground
the entry never considered — a phase gate with no running system behind it — and the
`BACKLOG.md` entry is annotated to point here.

## Decision

**Tester does not run at the Phase 5a gate.** `adversarial-test` resolves to `validator` for
5a packets, and the falsification Tester would have performed by hand is written as a
**threshold-binding spec** instead.

It shifts each of the five thresholds one unit in each direction and asserts that every
fixture whose verdict should flip does flip, and every fixture whose verdict should not stay
put. A threshold that can move without changing any verdict is a threshold no fixture binds,
and the spec fails on it.

It lives inside the package, at `platform/analysis-engine/test/analyzer/`, and runs under the
package's own `test` script — therefore under `pnpm gates`, therefore in CI on every later
phase. It is deliberately **not** a root `pnpm check:mutants` script: the only packets in 5a
that could write it own `platform/analysis-engine/**` and nothing else, so a root script would
be out-of-lane work with no lane to own it, and a root alias that fails until the spec exists
is a broken gate for the two waves before it. The name `check:mutants` is not used, to avoid
implying full mutation testing — Stryker over this package is a separate `BACKLOG.md` entry.

The spec is a 5a deliverable, landed by `p5.det-candidate`. Until it exists this decision is
not in force — the deviation is only paid for by the thing that replaces it.

`CLAUDE.md` is the higher authority here on its own terms: it says the deterministic gates are
run _before_ dispatching any validation agent precisely because they catch a large share of
what an agent would spend tokens discovering. On 5a they catch essentially all of it.

This is scoped to **5a only**. Phase 5b puts the same analyzer behind `POST /v1/analysis/run`
with persistence and a Dashboard, and at that gate there is a running system, so Tester's
stated edge returns. Nothing here weakens the 5b gate, and nothing here changes any other
phase.

## Consequences

- The 5a gate is cheaper and repeatable. The threshold-binding spec runs in CI on every
  later phase; a Tester session runs once and its findings decay.
- **What is lost is real.** A script tests the mutations somebody thought of. Tester's actual
  value is the input nobody designed for, and no threshold-shifting loop generates that.
  5a accepts that loss on the grounds that the surface is fifteen JSON fixtures and two pure
  functions, not on the grounds that scripts are as good as adversaries.
- `.claude/rules/agent-activation.json` and this record now disagree in the literal reading.
  The file is not edited: it states the general policy correctly, and a per-phase exception
  baked into it would leak 5a's shape into every future dispatch. `pnpm lanes wave 5` will
  keep listing `tester` under `optional_agents`, and it correctly stays unrun.
- A future phase with the same pure-function shape has a precedent it can cite instead of
  re-litigating. That is a risk as much as a benefit — see Detection.

## Detection

This decision is wrong if either of the following is observed:

1. **A 5a defect reaches 5b or later that the threshold-binding spec structurally could not
   have caught** — a false positive from an input shape nobody enumerated, a gate that binds on
   the fixtures but not on real telemetry, an aggregation error that survives every threshold
   shift. Whoever diagnoses it (`diagnostician`, or Tester at the 5b gate) sees it first, and
   the fix is to run Tester on the analyzer retrospectively, not merely to add a fixture.

2. **This record starts being cited to skip Tester on a phase that does have a running
   system.** The `reflector` pass at the next milestone boundary reads
   `docs/decisions/` and is the one that would notice. The narrow ground here — no running
   system at all — is the whole justification, and a citation that ignores it is a misuse of
   the record rather than an extension of it.

If the threshold-binding spec is not landed by the 5a gate, this decision has not been paid
for, and Tester runs.
