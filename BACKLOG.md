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

## Discovered while wiring structured logging (2026-08-16)

### `pnpm gates` fails on an untracked local settings file

`prettier --check .` reports `.claude/settings.local.json`, which is a per-developer
permissions file, untracked, and ignored globally rather than by this repository's
`.gitignore`. `.prettierignore` therefore does not exclude it and the format gate fails for
anyone who has one. Observed 2026-08-16: `pnpm gates` stops at `format:check` with that file
as the only complaint; every other gate stage passes.

One line in `.prettierignore` fixes it. Left alone here because it is outside the change that
found it, and a formatting fix riding in an unrelated diff is invisible to review.

**Addressed 2026-08-16** during the first Docker execution. It stopped being outside the
change that found it: `pnpm gates:full` had to be green to claim the Phase 1 Definition of
Done, and this file was the only thing standing in the way.

### The logger has no `WARN`-and-above escalation path

`scripts/lib/log.ts` throws on an unsound event, which is right for a script. An agent-side
caller may want the event downgraded and recorded rather than the run aborted. Worth deciding
once something outside `pnpm lanes` emits events; deciding it now would be designing against
a caller that does not exist.

---

## Discovered during a product-strategy session (2026-08-16)

### The first thing that gives a user value is the last thing built

**Source:** product-strategy session, 2026-08-16 — a strategy finding, not an implementation
finding. No command, fixture or file produced it; it is a cross-read of §20.2, Phase 4 and
Phase 5 work packages.

§20.2 Repeated Failed Action fires on three consecutive failed attempts with the same
`inputFingerprint` — inside a single run. No `contextKey`, no gates, no volume. It is the only
analyzer that produces output for a user on their first run. It is scheduled for Phase 5, work
package 4, with fixtures R1–R3 marked "Introduced: Phase 5". Run Explorer is Phase 4; the SDK
is Phases 2–3.

Consequence: under the current build order a new user gets nothing until the second-to-last
phase. This reads the two analyzers as two value tiers rather than as two peers — §20.2 works
at volume zero, §20.1 needs G1×G2 (30 samples × 5 contexts). The plan never frames them that
way.

Not a request to re-sequence the approved MVP. `CLAUDE.md` forbids redesigning it mid-flight.
Decide at the Phase 3→4 boundary, where the ordering consequence becomes real.

### The plan already picked a beachhead without declaring it

**Source:** product-strategy session, 2026-08-16 — a strategy finding, not an implementation
finding. No command or fixture produced it; it was observed by reading Phase 6 Scenario 3 and
§20.2's required example.

Phase 6 Scenario 3 uses decisionType `run_tests_after_code_change` with contextKeys
`post_edit_small_diff`, `post_refactor`, `post_dependency_bump`, `post_config_change`. §20.2's
required emission example is `run_tests("checkout.spec.ts") → FAILED ×3`. The reference
consumer is a coding/QA agent.

Argued rationale for making that explicit: G5 (outcome coverage >= 80%) is the scarcest input
in the product, and coding/QA is the only candidate domain where attestation is automatic and
objective — a test exit code. Customer-facing agents have volume but no cheap ground truth,
and §26 excludes Authentication and Multi-Tenancy, which that market requires on day one.
Internal automation has bespoke workflows, so `contextKey` means something different per
customer.

The identified risk is not volume. It is `workflowVersion` churn: §18 makes `workflowVersion`
part of the group key and fixture D8 shows a 50-sample group splitting into 26+24 and both
halves failing G1. Coding agents change prompts often, and each change resets the counter.

No product change requested. Record so the Playground's implicit domain choice is a stated
one, and so the churn risk is visible before Phase 6.

### `contextKey` is an onboarding wall with no on-ramp

**Source:** product-strategy session, 2026-08-16 — a strategy finding, not an implementation
finding. No command, fixture or file produced it; it comes from reading §14 and §19.

§14 requires the caller to compute `contextKey` and forbids the Platform from inferring it.
The epistemic rule is correct for aggregation claims. As an onboarding requirement it asks a
new user to formalize their domain's equivalence classes before they have seen any value, and
§14 also makes cardinality entirely their obligation with no feedback loop — a
high-cardinality key is indistinguishable from a diverse one until the data runs out.

Two candidate mitigations, neither designed:

- Caller-side derivation helpers shipped in the SDK (e.g. deriving a key from a declared set
  of coarse enumerated fields). The derivation still runs in the caller's process, so §14's
  boundary holds; the Platform still infers nothing.
- A progress display toward the gates ("17/30 samples · 3/5 contexts · needs 13 more samples,
  2 more contexts") instead of an empty result. Same thresholds, but it makes the wait legible
  and teaches what `contextKey` is without a document.

Explicitly not: lowering G2 for low-volume users. G2 is the differentiator per §2, and a lower
default manufactures exactly the false positives the plan names as the failure mode.

---

## Discovered during the first Docker execution (2026-08-16)

Three defects, all in files committed earlier and executed for the first time on this date.
All three are fixed; what follows is what was deliberately **not** chased.

### `@vercel/nft` resolves `@swc/helpers` differently under pnpm's isolated layout

**Source:** Diagnostician, `.artifacts/diag-dashboard-swc/`.

`@swc/helpers` lists `module-sync` first in its exports map. Node 24 honours that condition
from `require()` and lands on `esm/_interop_require_default.js`; Next 16.3.1's tracer takes
the `default` target and records `cjs/_interop_require_default.cjs`. Under a flat
`node_modules` the tracer records both and the standalone output boots; under pnpm's default
symlinked layout it records only the CJS variant and the container restart-loops on
`MODULE_NOT_FOUND`.

Verified empirically in both directions. The internal mechanism — why the layout changes
which condition the tracer picks — is **not** established, and establishing it belongs in a
Next.js issue with a minimal repro, not in this repository. `docker/dashboard.Dockerfile`
works around it with `--config.node-linker=hoisted` on both the install and the build.

Two untested alternatives, recorded so nobody re-derives them: declaring `@swc/helpers` as a
direct dashboard dependency (reasoning says no — the package is already present and correctly
symlinked, only its `esm/` subdirectory is missing, but that is inference), and
`outputFileTracingIncludes` in `next.config.ts` (the glob would have to encode the `.pnpm`
hash directory name, which changes on every peer-dependency bump).

### Cost of hoisting the dashboard build stage is unquantified

**Source:** same investigation.

`--config.node-linker=hoisted` takes the filtered install from 9 top-level packages to 547 and
runs the `@swc/core`, `esbuild`, `prisma` and `@prisma/engines` postinstalls. Build stage only
— the runtime image is assembled from `.next/standalone` and is unaffected — but build time
and build-cache size both rise, and neither was measured. Revisit if CI build time becomes a
constraint; it is not one for a local-only MVP.

### `platform/dashboard/tsconfig.tsbuildinfo` is tracked

**Source:** observed in `git status` after a dashboard build.

It is a TypeScript incremental-build cache, it is not in `.gitignore`, and it is committed.
Every build dirties the working tree with a file nobody reads, which trains everyone to
`git add .` past it — and that is how an unrelated change rides into a commit unnoticed. Fix
is `.gitignore` plus `git rm --cached`, but that is a tracked-file removal outside the change
that found it, so it is recorded rather than done here.

### `pnpm test:integration` needs Docker on PATH, and nothing says so

**Source:** observed while running the Phase 1 validation block.

A shell without `C:\Program Files\Docker\Docker\resources\bin` on PATH fails with
`spawn docker-credential-desktop ENOENT` from inside Testcontainers' credential provider —
which reads as a Testcontainers bug rather than a missing PATH entry. Cost a diagnostic cycle
here. Worth a line in the README's prerequisites when `p7.readme` is written, since Phase 7's
clean-clone smoke test will hit exactly this on a fresh machine.

---

## Environment prerequisites (not backlog — blocking)

- ~~**Node.js v21.0.0**~~ — resolved 2026-08-14. Node 24.19.0 LTS and pnpm 11.21.0 are
  installed and the whole toolchain runs on them.

- ~~**Docker is not installed, and neither is WSL2.**~~ — resolved 2026-08-16. WSL2 with an
  Ubuntu distro was already present; only Docker Desktop was missing. Docker 29.7.2 and
  Compose v5.3.1 now run, `docker compose up --wait` exits 0 with all three services healthy,
  and `pnpm test:integration` passes against a Testcontainers PostgreSQL.

  The warning above was right. Running those files for the first time found three defects in
  code that had been committed and never executed — see _Discovered during the first Docker
  execution_ below. Note for every future phase that adds a container surface: the first run
  is a review, not a smoke test.
