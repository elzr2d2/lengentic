# CONTEXT

The shared language of LenGentic. One term, one meaning, used by humans, agents, and the
code alike — so a sentence about this project costs a word instead of a paragraph.

This is a **glossary, not a spec.** Every term points at the section that owns its
mechanics. Where this file and `MVP_PLAN_V3.md` disagree, the plan wins and this file is
stale — fix it.

---

## The two halves

**Platform** — the product: `platform/api`, `platform/analysis-engine`,
`platform/telemetry-sdk`, `platform/shared`. Ships.

**Playground** — the instrumented example agent that produces telemetry to look at.
Disposable. The Platform must build with `playground/` deleted; `pnpm check:isolation`
proves it.

**SDK** — `platform/telemetry-sdk`, the public artifact. Consumers install it to emit
telemetry, so it may import `platform/shared` and nothing else. §6.

**Wire contract** — the Zod schemas in `platform/shared/schema/**`. The single source of
every type that crosses a process boundary; SDK and API both derive from it with
`z.infer`. Prisma types are database-internal and never cross a module boundary.

---

## What the product observes

**Run** → **Step** → **Decision**, plus `ModelCall`, `ToolCall`, `Error`. §13.

**Decision** — one recurring decision point, its `availableOptions`, and the
`selectedOption`. The unit everything downstream aggregates.

**contextKey** — a short stable string, **computed by the caller**, bucketing the situation
a decision was made in. The Platform groups by it and never infers it: the caller knows
what makes two situations equivalent in their domain, and the Platform does not. A decision
with no `contextKey` is stored and **excluded from aggregation**. §14.

**contextKeyVersion** — the version of the caller's bucketing strategy. A change **splits**
groups rather than silently corrupting them.

**Attestation** — the caller asserting a `Decision`'s `outcome`. Idempotent, keyed on
`decisionId`, and allowed to arrive from another process hours later. §14.

**attested** — the standing adjective for anything outcome-derived. Say **attested success
rate**; never _measured_. The caller asserts the outcome and LenGentic has no independent
way to verify it, so the word carries the epistemics. `outcomeAttestedBy` records who
asserted.

**Counterfactual** — what would have happened had the other option been chosen. LenGentic
**never observes one.** Any claim that a decision "does not require an LLM" is a
counterfactual claim and is forbidden. §2, §19.

---

## What the product computes

**Group key** — `(workflowName, workflowVersion, decisionType, contextKeyVersion)`. §18.

**Dimension** — `contextKey`, measured _within_ a group, never part of its identity. It is
the diversity bucket that licenses the claim _"this option wins across varied situations."_

**eligible / attested** — the two denominators. Selection is observed even when outcome is
not, so selection-based metrics include `UNKNOWN` and outcome-based metrics do not. Getting
this wrong pins a gate to a constant and makes it unsatisfiable. §18.

**Safety gate** — `G1`–`G5`. All must pass; **every** failing gate is reported by name, not
the first. §19.

**SUPPRESSED** — the verdict when any gate fails.

**Counterexample** — a minority-option row that contradicts the dominant option. Every
deterministic recommendation carries a `counterexamples` field. It may be empty; it is
never absent.

**minorityContextConcentration** — a group-by over the minority rows. Turns a list of
counterexamples into a statement about _where the escape hatch goes_. §18.

**Escape hatch** — the conditional carve-out a recommendation names. Recommendations
suggest a default with an escape hatch, never a replacement, because no gate produces a
counterfactual.

**Hypothesis** — what a recommendation is. Never an assertion. It ships with its
counterevidence attached.

---

## How the work is built

**Phase** — a numbered unit of `MVP_PLAN_V3.md` PART III, each with a **Definition of Done**
(DoD). One phase at a time; the next never starts automatically.

**DoD** — the checkbox list that decides _complete_. Evidence per checkbox, or `NOT MET`.
Not the task list.

**Work packet** — one deliverable, sliced by `pnpm oracle packet <id>`. A subagent gets a
packet, never the plan. `docs/PARALLEL_EXECUTION.md` §3.

**Wave** — the set of packets whose blockers are all done, dispatched together.
`pnpm oracle waves`. Validate per wave; review per phase.

**Lane collision** — two packets in one wave touching the same directory. Serialise, or
give one a worktree. Never dispatch both into the same tree and hope.

**Gate** — a deterministic check. `pnpm gates` for task completion, `pnpm gates:full`
before a commit. Never ask an agent to verify what a gate can verify.

**Handoff** — the JSON an agent returns, shaped by `.claude/rules/handoff.schema.json` and
checked by a hook. `owner` is who acts **next**, never the reporting agent.

**Backlog** — `BACKLOG.md`. Where anything valuable and unnecessary for the current DoD
goes, the moment it appears. With its `Source`, or it is unactionable later.

---

## How the code is shaped

**Seam** — the public boundary you observe behaviour at without reaching inside. Tests live
at seams. A test is written only at a seam that was **agreed before it was written**.

**Mutation check** — _would this test still pass if the code under test were deleted?_ If
yes, the test proves nothing. The standing defence against a **green that lies**.

**Green that lies** — a passing test that would pass whether or not the feature works: a
tautological oracle, a presence-only assertion, an expected value fetched from the call that
produced the actual, an oracle that accepts two different outcomes.

**Negative fixture** — the failing case, written **before** the positive path. False
positives are the failure mode that kills a recommendations product.

**Deep module** — a lot of behaviour behind a small interface. The shape to aim for; the
`codebase-design` skill holds the full vocabulary.

**Tracer bullet** — a narrow but complete vertical slice through every layer, demoable on
its own, sized to fit one fresh context window.
