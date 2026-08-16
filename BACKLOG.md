# BACKLOG

Ideas that are valuable but not required by the current phase's Definition of Done
(`MVP_PLAN_V3.md` §8). Nothing here may expand the active phase.

The standing post-MVP list lives in `MVP_PLAN_V3.md` §27 and is not duplicated here. This
file records items **discovered during implementation**, with the discovery context that
makes them actionable later.

---

## Discovered during Phase 0 plan review (2026-08-14)

### Context-conditional defaults

**Source:** corrections doc §1.
The corrected group key aggregates across `contextKey`, which licenses the claim _"this
option wins across varied situations."_ A per-`contextKey` analyzer would license a
finer claim — _"in `post_refactor_large_diff`, always NO"_ — which is more actionable but
needs far more data per group and directly contradicts G2's purpose. A real v2 analyzer,
not an MVP variant of the existing one.

### Recommendation demotion on regression

**Source:** [Progressive Crystallization](https://arxiv.org/abs/2607.07052), §0 of the
corrections doc.
That system pairs promotion with a circuit-breaker that demotes a deterministic playbook
back to hybrid on execution failure or acceptance-test regression. LenGentic has an
`ACCEPTED` recommendation status and no mechanism to notice that an accepted default
stopped holding. Related to, and probably subsumed by, §94's **shadow mode**, which is the
honest version — it produces the counterfactual instead of inferring it.

### Weight counterexamples by attestation

**Source:** observed in fixture `D2`.
`D2` reports three counterexamples: one attested `SUCCESS` and two `UNKNOWN`. A dissent
whose outcome was never attested is weaker evidence than one known to have succeeded, and
the current output gives them equal visual weight. Options: sort attested-first, annotate
the count as "3 (1 attested)", or exclude `UNKNOWN` dissents from the concentration
calculation. Deliberately **not** decided in Phase 0 — it changes what the report claims,
and the fixtures should drive that decision rather than an aesthetic preference.

### Concentration output is noisy for wide minorities

**Source:** observed in fixture `D9`.
A 60/40 split across 11 contexts prints an 11-row concentration table for a group that
produced no recommendation. The rows are correct but carry no signal — a scattered
minority is a single finding ("the boundary is not context-shaped"), not eleven. Consider
collapsing to a scatter/concentration summary when no single context exceeds some share.

## Discovered during Phase 1 (2026-08-14)

### Slim the API runtime image

**Source:** `docker/api.Dockerfile`.
The runtime stage copies the whole built workspace, dev dependencies included, because
`pnpm deploy` needs `inject-workspace-packages=true` and that setting replaces local
symlinks with copies, which degrades the day-to-day dev loop. The dashboard image is
already lean via Next's `output: 'standalone'`. Revisit if image size becomes a real
constraint; it is not one for a local-only MVP.

### Upgrade to the next tooling majors

**Source:** pnpm reported newer majors during install.
ESLint 10, TypeScript 7, and dependency-cruiser 18 are all available. TypeScript 7 is the
Go port, and NestJS, Prisma, and typescript-eslint have not all landed support. Deferred
deliberately: a portfolio project that cannot build is worse than one on a
six-month-old compiler. Revisit once `typescript-eslint` ships a TS 7 parser.

### Teach Validator the mutation check

**Source:** §35 harness validation run with live agent dispatch (2026-08-15).

Validator correctly identified a false-positive test — `harness.controller.spec.ts` had
re-declared its own copy of the schema under test, so it stayed green while the endpoint
was broken. Validator then authored a replacement contract test that had **the same defect
in a different shape**: it drove `?a=1e308`, which the parameter regex rejects before the
code under test is reached, and its oracle was `if (status === 200) expect a number; else
expect 400` — an assertion satisfied by both branches of the behavior it was testing.
Deleting the guard it claimed to cover left all 19 tests green. Verified mechanically.

`.claude/agents/validator.md` already says "detect false-positive tests." That is the
_goal_, not a _method_, and the goal alone did not prevent Validator from writing one.
The concrete technique is a mutation check: **would this test still pass if the code under
test were deleted?** Also worth stating that an oracle accepting two different outcomes is
not pinning a contract.

Deferred because §36 asks that agent responsibilities be _defined_, and they are. This
sharpens how well one of them is discharged, which is a real improvement and not a
Definition-of-Done item. Do not fix by adding a rule to every agent file — it belongs to
the role that writes tests.

**Addressed 2026-08-16** by `.claude/skills/test-at-seams/SKILL.md`, which owns the method:
agree the seam before writing, source the expected value independently, then perform the
mutation check by actually deleting the guard and watching the test. `validator.md` and
`builder.md` point at it; no rule was copied into either. The lexical shapes are also caught
by `pnpm check:integrity`, but a tautological oracle is not lexical, which is why the
mutation check stays a hand action.

### Rename `zodBody` — it is used at `@Query` sites too

**Source:** Reviewer finding, §35 harness validation run (2026-08-15).

`platform/api/src/common/zod-validation.pipe.ts:36` exports `zodBody`, and its docstring
says controllers should read as `@Body(zodBody(EventBatchSchema))`. The disposable §35
endpoint used it at a `@Query` site, where it works correctly but the name is a lie.

This is permanent Phase 1 code and Phase 2's ingestion controllers will copy whatever
precedent it sets. Options: rename to `zodPipe`, or keep `zodBody` and add a `zodQuery`
alias so the call site reads honestly. Not urgent — nothing is wrong at runtime — but it
gets more expensive to change once §41's ingestion endpoints exist.

## Discovered during agent-harness refinement (2026-08-16)

### Nine-agent roster — deliberate deviation from §18 / v3 §9

**Source:** human decision, 2026-08-16.

`MVP_PLAN.md` §18 and `MVP_PLAN_V3.md` §9 specify a roster of four (Architect, Builder,
Validator, Reviewer), with Diagnostician and Reflector created **only when a real failure
demands them**, and §21 merges v1's Runner and Tester into Validator because the handoff cost
exceeded the separation benefit.

Five further agents — `runner`, `tester`, `watchdog`, `diagnostician`, `reflector` — were
present in `.claude/agents/` as imports from another project, and the decision was taken to
keep all nine rather than delete the unsanctioned five. They were rewritten to this
repository with non-overlapping scopes:

```text
runner        execute, report raw evidence, interpret nothing
validator     per-packet / per-wave behavioural validation   (the hot path)
tester        per-phase adversarial falsification, fresh session
watchdog      judgement layer over `pnpm check:integrity` + diff scope
diagnostician escalation from a BLOCKED handoff with unclear cause
reflector     cross-milestone process and cost retrospective
```

The cost this carries is standing context load and a real risk that two roles get invoked
"to be safe". `reflector` owns detecting that: if a milestone shows `runner`, `tester`, or
`watchdog` invocations whose output never changed a decision, the §21 merge was right and
they should collapse back into `validator`.

`handoff.schema.json`'s `owner` enum gained `diagnostician` and `human`. The reporting-only
roles are never an owner, so the enum did not grow to nine.

### Watchdog's lexical scan became a script

**Source:** `CLAUDE.md` — never ask an agent to verify what a script can verify.

`scripts/check-integrity.ts` and `pnpm check:integrity` now own every lexical QA-integrity
pattern, wired into `pnpm gates`. It found one live `WARN` on first run:
`platform/api/src/health/health.service.spec.ts:32` asserts `.toBeDefined()` where the
health check's business outcome is a status value. Not fixed here — it is Phase 1 test code
and belongs to whoever next touches that suite.

Two categories from the original agent could not be made deterministic and were dropped
rather than faked: "newly introduced skip" needs a diff baseline the script does not have,
and "scope creep" needs the work packet. Both moved into `watchdog`'s judgement half.

### PR Brief convention retired before it was ever written

**Source:** `reflector.md`, superseded by `docs/PARALLEL_EXECUTION.md` §3.

`reflector` carried a 40-line convention for a committed per-PR brief that would let a fresh
agent start from minimal context. `pnpm oracle packet <id>` already does exactly that, from
the plan, without a second document to keep in sync. The convention was deleted rather than
reconciled. If packets ever stop carrying enough context, revive the idea — but as a change
to the oracle, not as a parallel artifact.

## Discovered while building the lane workflow (2026-08-16)

### Only Phase 2 has path ownership

**Source:** `scripts/oracle/graph.json`, `lanePolicy`.
Ten Phase 2 nodes carry `own.allowed`, `validate`, `risk` and `changeClass`. The other
thirty-five do not, so every one of them fails R3/R7/R10 in `pnpm lanes decide` and runs
sequentially. That is the correct default and not a bug — but it means Phases 3–7 cannot
fan out until someone annotates them, and annotating a phase is a decision about who owns
which directory, not a formality. Do it at the start of each phase, not in a batch now:
paths for code that does not exist yet are guesses, and a guessed boundary is worse than an
absent one because the gate then reports green.

### `diagnostician.md` names commands this repository does not have

**Source:** `.claude/agents/diagnostician.md:28`.
It instructs the agent to reproduce against `npm run dev` with web on `:4173` and API on
`:8787`. Neither port appears anywhere else in the repository, the package manager is pnpm,
and `docker-compose.yml` exposes 3000/3001. The file is untracked and was imported from
another project. Left alone deliberately — it is uncommitted work in progress — but a
Diagnostician dispatched today would report an environment failure against a URL that never
existed. Fix it before the first non-obvious failure, or the first thing Diagnostician
diagnoses will be itself.

### The lane matcher exists twice

**Source:** `.claude/hooks/lib/match-path.mjs` and `scripts/lanes.ts`.
The PreToolUse hook cannot import from `scripts/` — it has to work before `pnpm install`,
same constraint that made `validate-schema.mjs` reimplement a JSON Schema subset. So the
glob matcher is written twice, and `pnpm check:lanes` scenario 20 asserts the two agree on a
table of cases. Acceptable, and cheaper than the alternatives, but the parity table is the
only thing holding them together — extend it whenever either side learns a new pattern form.

### `pnpm lanes decide` has no cost model

**Source:** requirement R12.
"Estimated benefit exceeds overhead" is currently a count heuristic: at least `minUnits`
units, each self-contained. Real overhead is dispatch tokens plus review plus integration
plus the probability of a conflicted merge, and none of that is measured. The telemetry in
`.artifacts/telemetry/lanes.jsonl` is where the data to replace the heuristic will come
from — after enough batches for Reflector to have something to fit.

---

## Discovered while specifying Agentic System Awareness (2026-08-16)

`MVP_PLAN_V3.md` §29 defines the capability and stages it. Stage 1 is Phase 3 work. Stages 2
and 3 are recorded here and in §27, and are **not** MVP deliverables — the evidence they
would operate on does not exist yet.

### Awareness Snapshot — sequential vs parallel comparison

**Source:** §29 stage 2.
An on-demand snapshot comparing the two strategies on success rate, duration, token usage,
retries, rework, conflicts and validation failures, plus dominant-option failures and
minority-option successes. It is an ordinary §20 analyzer over
`decisionType = execution_strategy` and needs no new gate — G1–G5 already say `SUPPRESSED`
when the evidence is thin, which is the honest answer for the entire MVP window.

Not built now because a comparison over zero parallel runs is fabricated, not cautious. The
Phase 3 instrumentation is what lets this be added later without a migration.

### Orchestrator consumption of strategy recommendations

**Source:** §29 stage 3.
An external orchestrator asking LenGentic what to do, and acting on it. Requires explicit
opt-in, guardrails, rollback, policy enforcement and sequential fallback — all of which are
the orchestrator's obligations, not the Platform's. §4 forbids the reverse direction
permanently: LenGentic exposes evidence and never reaches into a running system.

### Evaluator threshold telemetry

**Source:** §29 condition 11, and the same gap already recorded above for lane requirement R12.
`availableConcurrency >= 2` and the configurable maximum are both asserted, not derived. The
product evaluator will accumulate the same kind of evidence `.artifacts/telemetry/lanes.jsonl`
accumulates for the harness. Worth revisiting once there is enough of it to fit — as one
change, since both are the same unmeasured overhead question wearing different clothes.

---

## Environment prerequisites (not backlog — blocking)

- ~~**Node.js v21.0.0**~~ — resolved 2026-08-14. Node 24.19.0 LTS and pnpm 11.21.0 are
  installed and the whole toolchain runs on them.

- **Docker is not installed, and neither is WSL2.** This blocks four `MVP_PLAN_V3.md` PHASE 1
  checkboxes — "PostgreSQL starts", "API reaches PostgreSQL", "`docker compose up`
  succeeds" — plus `pnpm test:integration`, since Testcontainers needs a daemon.

  Docker Desktop on Windows requires WSL2 or Hyper-V, so this is an elevated install plus
  a reboot, not a package fetch:

  ```
  wsl --install
  winget install Docker.DockerDesktop
  ```

  Everything else in Phase 1 is verified. `docker-compose.yml` and both Dockerfiles are
  written but **have never been executed** — treat them as unreviewed until
  `docker compose up` runs once.
