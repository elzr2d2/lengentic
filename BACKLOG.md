# BACKLOG

Ideas that are valuable but not required by the current phase's Definition of Done
(`MVP_PLAN_V3.md` §8). Nothing here may expand the active phase.

The standing post-MVP list lives in `MVP_PLAN_V3.md` §27 and is not duplicated here. This
file records items **discovered during implementation**, with the discovery context that
makes them actionable later.

Entries are **never deleted.** A resolved item gains an **Addressed `<date>`** paragraph and
stays where it is, because the reasoning that deferred it is worth as much as the fix. This
file is a ledger, not a queue — read the closing paragraph before assuming an entry is open.

An item deferred on "not enough data yet" must name **how much data**, or it is deferred
forever and nobody notices.

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

**Source:** [Progressive Crystallization](https://arxiv.org/abs/2607.07052) — Arun Malik,
"Turning Agent Exploration into Deterministic, Lower-Cost Workflows in Production",
submitted 2026-07-08. Citation verified 2026-08-16. Also §0 of the corrections doc.

That system pairs promotion with a circuit-breaker that demotes a deterministic playbook
back to hybrid on execution failure or acceptance-test regression. LenGentic has an
`ACCEPTED` recommendation status and no mechanism to notice that an accepted default
stopped holding. Related to, and probably subsumed by, §94's **shadow mode**, which is the
honest version — it produces the counterfactual instead of inferring it.

Two things worth carrying forward from the paper itself, since §2's prior-art table quotes
only its promotion gate. Its reported production result — deterministic execution 0% → 45%
over eight months, per-incident agent cost down >70% at doubled incident volume, on a cloud
networking AIOps platform handling tens of thousands of incidents monthly — is the closest
external evidence that the thesis LenGentic shares with it holds at scale, and §2 currently
cites the paper only to differentiate from it. Second: its domain, AIOps incident
resolution, has automatic objective attestation, which is a direct counterexample to the
"only coding/QA has cheap ground truth" claim recorded below under _the plan already picked a
beachhead_.

### Weight counterexamples by attestation

**Source:** observed in fixture `D2`.
`D2` reports three counterexamples: one attested `SUCCESS` and two `UNKNOWN`. A dissent
whose outcome was never attested is weaker evidence than one known to have succeeded, and
the current output gives them equal visual weight. Options: sort attested-first, annotate
the count as "3 (1 attested)", or exclude `UNKNOWN` dissents from the concentration
calculation. Deliberately **not** decided in Phase 0 — it changes what the report claims,
and the fixtures should drive that decision rather than an aesthetic preference.

**Premise void 2026-08-17.** This entry assumed the Phase 0 reading, where a counterexample was
any minority-selected row and could therefore be `UNKNOWN`. §20.1's reading — landed in the
grid on 2026-08-17, see `.artifacts/evidence/5a/fixture-semantics-review.md` — counts only
attested rows, so an unattested dissent is not a counterexample at all and there is nothing to
weight. `D2` now carries four, all attested. What survives is the _concentration_ question:
`minorityContextConcentration` is still a group-by over minority rows, `UNKNOWN` ones included.

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

### Upgrade ESLint 10 and dependency-cruiser 18

**Source:** pnpm reported newer majors during install. Gate corrected 2026-08-16 after
checking upstream.

ESLint v10.0.0 shipped 2026-02 and is on 10.8.1; dependency-cruiser 18 is out. **Neither
depends on TypeScript 7** — the original entry bundled all three majors behind one blocker
that applies to only one of them, which is why nothing moved. These two are an ordinary
dependency bump and can go whenever a phase has room. Check `eslint-config-next` supports
ESLint 10 first (vercel/next.js#91702); that is the only known coupling.

### Upgrade to TypeScript 7 — blocked upstream, not by us

**Source:** same install, corrected 2026-08-16.

TypeScript 7.0 (the Go port) reached GA in 2026-08. The blocker is not "typescript-eslint
has not got round to it": typescript-eslint **closed the TS 7 support request as `not
planned` on 7.0 launch day**, because TS 7.0 ships without a stable programmatic API. That
API is targeted at **TS 7.1**, several months out as of mid-2026. Microsoft's
`@typescript/typescript6` package provides a `tsc6` executable and re-exports the 6.0 API so
tooling that imports `typescript` directly keeps working in the meantime.

So the trigger is precise and external: **typescript-eslint publishes a release naming TS 7.1
as supported.** Nothing this repository does moves it earlier. Deferred deliberately — a
portfolio project that cannot build is worse than one on a six-month-old compiler.

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

**Partly superseded 2026-08-16.** The count is no longer accurate: `pnpm lanes decide
p2.shared-schema p5.engine-pkg` returns `R3 ok`, `R7 ok`, `R10 ok` and `R14 ok` with
`p5.engine-pkg` declaring its own surface and packet source, so at least one node outside
Phase 2 is annotated. The reasoning above still holds and the policy is unchanged — annotate
at the start of the phase, never in a batch. Only the "thirty-five do not" figure is wrong.
Re-derive from `scripts/oracle/graph.json` before planning a fan-out on it; this entry was
cited in a delivery plan and the stale number would have added an annotation packet that was
not needed.

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

**Trigger (added 2026-08-16):** ≥20 dispatched batches in `lanes.jsonl` with both modes
represented, ≥5 of them parallel. Below that a fitted model is a story about four data
points. If the MVP ends without reaching it — likely, since it is one developer locally —
close this entry as _not reachable at this scale_ rather than carrying it indefinitely.

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

**Trigger (added 2026-08-16):** the gates already state it — G1 (30 `execution_strategy`
samples) and G2 (5 distinct `contextKey`s) on a single `(workflowName, workflowVersion)`
pair. That is the honest threshold and it is the same one every other group answers to. Say
so here rather than "later", because "later" is how an item outlives the project.

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

**Trigger (added 2026-08-16):** whichever of R12's ≥20 batches or the Awareness Snapshot's
G1/G2 arrives first. Do not fit either in isolation; the shared cause is that nobody has
measured what a parallel dispatch actually costs.

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
in the product, and coding/QA is the candidate domain where attestation is **cheapest** — a
test exit code the caller already has. Customer-facing agents have volume but expensive
ground truth, and §26 excludes Authentication and Multi-Tenancy, which that market requires
on day one. Internal automation has bespoke workflows, so `contextKey` means something
different per customer.

**Corrected 2026-08-16.** This entry originally said coding/QA is the _only_ domain where
attestation is automatic and objective. That is false, and the counterexample is sitting in
this same file: the Progressive Crystallization paper's domain is AIOps incident resolution,
where the outcome is attested by whether the incident closed. Any domain with a downstream
deterministic checker qualifies. The argument survives on **cheapness**, not uniqueness —
overstating it invites a rebuttal that discredits the whole section.

Market context, also checked 2026-08-16: the trace-and-eval layer this sits next to is
crowded — LangSmith, Langfuse, Braintrust, Arize, Opik, AgentOps, Laminar. The gated,
counterexample-carrying recommendation is a different object from a trace with eval scores
attached, so this is not a me-too. But coding/QA plus CI-gated evaluation is precisely
Braintrust's occupied ground, and this entry reads as though the slot were empty. It is not.
What none of them do is the `workflowVersion` churn problem named below — which is a better
differentiator than the domain choice.

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

**Surveyed 2026-08-16, after the fix was already in.** This failure is a well-known class,
and the survey should have happened before `node-linker=hoisted` was reached for:

- vercel/next.js [#48017](https://github.com/vercel/next.js/issues/48017) — missing
  dependencies in standalone output under pnpm.
- vercel/next.js [#95450](https://github.com/vercel/next.js/issues/95450) — standalone
  symlinks resolving outside `.next/standalone`. Reported as **Windows-only, not reproducing
  on Linux**, which matters: our build runs in a Linux container, so the mechanism recorded
  above may be misattributed even though the workaround empirically works.
- vercel/next.js [#40482](https://github.com/vercel/next.js/discussions/40482) — same shape
  in a pnpm monorepo.

The community fix is **`outputFileTracingRoot`** pointed at the workspace root, plus copying
store entries with `cp -rL` so scoped packages keep their internal symlinks. That is cheaper
than hoisting the whole build stage and is **not** among the two alternatives above. The
ingredients of our mechanism are real — Node's `module-sync` condition
([nodejs/node#54648](https://github.com/nodejs/node/pull/54648)) and `@swc/helpers` exposing
`module-sync` ([swc#9995](https://github.com/swc-project/swc/pull/9995)) both exist — but the
documented root cause in every report above is symlink handling during the standalone copy,
not the tracer choosing a different exports condition. Try `outputFileTracingRoot` before
filing anything upstream; a bug report resting on an unproven mechanism wastes a maintainer's
time and ours.

### Cost of hoisting the dashboard build stage is unquantified

**Source:** same investigation.

`--config.node-linker=hoisted` takes the filtered install from 9 top-level packages to 547 and
runs the `@swc/core`, `esbuild`, `prisma` and `@prisma/engines` postinstalls. Build stage only
— the runtime image is assembled from `.next/standalone` and is unaffected — but build time
and build-cache size both rise, and neither was measured. It is not a constraint for a
local-only MVP.

**Trigger, per this file's rule against unbounded deferral:** `p7.ci-full` is the first thing
that runs this build on a cold cache where the cost is visible. Measure the dashboard build
stage there and record the number in this entry. Revisit only if it exceeds **3 minutes cold**
or the build cache exceeds **2 GB** — otherwise close the entry with the measurement and the
finding that hoisting was free. Both figures are chosen as "obviously fine below this", not
derived; the point is that a number exists to test against, not that it is the right number.

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

## Discovered while pressure-testing the premise (2026-08-16)

Six findings about the thesis itself rather than about any implementation of it. None was
produced by a command or a fixture; all came from reading §1, §2, §14, §18, §19 and §20
against each other and against the outside world.

Every one of these touches `MVP_PLAN_V3.md`. **None may be taken mid-phase** — `CLAUDE.md`
forbids redesigning the approved MVP while implementing it, and two of them change what a
gate means. Recorded here so the decision is available at the boundary where it becomes
cheap, and so nobody re-derives the argument from scratch.

### `workflowVersion` belongs in the dimension, not the group key

**Source:** premise review, 2026-08-16. §18 group key vs fixture D8.

§18 makes `workflowVersion` part of the group key, so a prompt edit **splits** the group.
Fixture D8 already demonstrates the cost: a 50-sample group splits into 26+24 and both halves
fail G1. The window in which a group can reach 30 samples is therefore the window in which
nobody edits the workflow — and agentic systems are the least version-stable software there
is. The realistic steady state for a real caller is `SUPPRESSED` forever, which is
indistinguishable from broken.

The candidate inversion: keep `workflowVersion` as a **measured dimension inside** the group,
exactly as §18 already does for `contextKey`, and add a gate requiring dominance to hold
within every version present. Three consequences, and the second and third are why this is
worth the disruption:

- Churn stops destroying evidence. A default that survives three prompt revisions is
  strictly stronger evidence than one observed inside a single revision; the current design
  discards its best available signal as contamination.
- **Dominance reversal across versions becomes a finding** — which is the circuit-breaker
  demotion §2 explicitly records as absent, obtained as a by-product rather than as post-MVP
  shadow mode. See _Recommendation demotion on regression_ above; this may subsume it.
- G2's claim gains a second leg: diversity across situations _and_ across system versions.

The real cost, stated so it is not discovered later: a version bump can genuinely change what
a decision means, and this design would blend two different decisions under one group. That
case is not silent — it surfaces as a reversal — but "surfaces as a finding" is weaker than
"cannot happen", which is what splitting buys today. The trade is deliberate and is the whole
decision.

Not a Phase 1–3 change. §18 and §19 are load-bearing for every fixture already written.

### Ship the gate verdict as a finding, not only the recommendation

**Source:** premise review, 2026-08-16. §19 reporting rule.

`SUPPRESSED` is currently a terminal state with no payload beyond which gates failed. But
"50 samples, all in one `contextKey`" is a **finding today** — it says the agent kept meeting
the same situation and that repetition is being mistaken for evidence. That is worth telling
a caller at volume 50, with no recommendation emitted and no epistemic claim made.

Pairs with _`contextKey` is an onboarding wall_ below, which proposes the same surface from
the onboarding side ("17/30 samples · 3/5 contexts"). They are one feature: a gate verdict
that carries a **distance and a diagnosis** instead of an absence. Recorded separately
because the arguments are independent — one is about teaching a new user, this one is about
the product having something true to say in the state it will spend most of its life in.

Thresholds unchanged. This adds no claim; it reports the shape of the evidence already
computed in §18.

### The thesis has no falsification criterion

**Source:** premise review, 2026-08-16. §1, §2, Phase 0 exit.

Phase 0 is recorded complete on the grounds that "all nine fixture groups produce agreed
verdicts" — against fixtures written by the same people who wrote the thesis. In this
project's own vocabulary that is a **green that lies**, one level above the code: the
analyzers are falsifiable and well tested, the premise they serve is not.

The premise is also never stated in one sentence; it is distributed across §1, §2, §18 and
§19, and a claim spread over four sections cannot be contradicted. A single line would fix
both — roughly: _for a recurring agent decision, option dominance that persists across varied
contexts is evidence the decision can carry a deterministic default with a named escape
hatch_ — followed by what observation would refute it. The honest refutation is a group that
clears G1–G5, whose default is adopted, and whose attested success rate then drops.

The MVP cannot run that test; §2 already concedes there is no demotion mechanism. State the
criterion anyway. A thesis with a stated, currently-unrunnable falsification is honest; one
with no criterion at all is unfalsifiable, which is the failure mode §2 exists to prevent
everywhere else.

### §1's fourth question invites the claim §2 forbids

**Source:** premise review, 2026-08-16. §1 vs §2, same document.

§1 asks _"Can part of this probabilistic behavior become deterministic software?"_ §2 forbids
_"This decision does not require an LLM."_ These are the same sentence at different
confidence levels, and §1 is the one on the README-facing side. The document argues with
itself, and the version a reader meets first is the forbidden one.

A reframing that keeps the product and drops the counterfactual: _"Which of these decisions
do we have enough evidence to stop guessing about?"_ Same loop, same analyzers, no claim
about what would have happened otherwise.

This is also the commercial gap in miniature. The paper cited above sold on >70% cost
reduction — a counterfactual claim LenGentic has structurally banned itself from making. The
resolution is to move the pitch to evidence quality, which is claimable and which nothing in
the crowded observability layer currently occupies. Not to weaken §2.

Documentation-only, and the smallest item here.

### The five thresholds are undefended

**Source:** premise review, 2026-08-16. §19.

`30 / 5 / 90% / 90% / 80%` are load-bearing, configurable, and given without provenance. For
a product whose entire position is epistemic humility, five unexplained magic numbers at the
exact point where the claim is made is the one place it does not apply its own standard.

Not asking for derivation — there is no data to derive from, and inventing one would be worse
than admitting none. Asking for a paragraph in §19 saying these are **defaults, not
findings**, naming what evidence would justify each, and stating that a caller who changes
them changes what the recommendation means. Cheap, honest, and it pre-empts the first
question any reviewer asks.

### One structurally independent attestation in the demo

**Source:** premise review, 2026-08-16. §14's "marking its own homework", §25.

§14 concedes the Playground both generates decisions and grades them, and requires that this
be visible via `outcomeAttestedBy`. Honest, and correctly handled. The consequence it does
not draw: **every attested rate in the demo is synthetic**, so the one input the entire design
depends on is the one thing §25 never demonstrates.

One scenario would fix it — a decision whose `outcome` comes from a real process result, a
test exit code or a compile result, rather than a scripted verdict. No new infrastructure, no
schema change, `outcomeAttestedBy` stays `CALLER`. It is also the honest version of the
coding/QA beachhead argument recorded above: not "this domain is best" but "here is the
attestation actually working end to end, once."

Phase 6 scenario work. Recorded now because by then the scenarios will be written and adding
a differently-shaped one will look like scope creep instead of the point.

---

## Discovered while wiring the dumbzone detector (2026-08-16)

`.claude/hooks/dumbzone-detector.mjs` warns when session context passes 100K/120K/150K tokens,
`.claude/skills/session-handoff/` writes the continuation brief, and
`.claude/hooks/inject-session-handoff.mjs` injects it on the next `/clear`. Two gaps were left
open deliberately.

### Nobody measures what a lane costs in context

**Source:** observed while choosing where the detector could fire.

`UserPromptSubmit` does not fire inside a subagent, so a lane cannot detect its own dumb zone
and the Coordinator never learns how much window a packet consumed. `SubagentStop` receives
`agent_id`, `agent_type` and a transcript path, so the last assistant turn's `usage` — the same
figure the detector already reads — could be appended to `.artifacts/telemetry/lanes.jsonl` per
dispatch, at the cost of one hook.

This is the missing half of _`pnpm lanes decide` has no cost model_ above. That entry names
"dispatch tokens plus review plus integration" as unmeasured and points at the same JSONL file;
this is the mechanism that would measure the first term, and a packet that repeatedly lands a
lane past 100K is also the packet that was sliced too wide. Do it as one change with R12, not
separately, and inherit R12's trigger: **≥20 dispatched batches with both modes represented.**
Instrumenting earlier is cheap, but fitting anything to it is not.

### The write half is model-in-the-loop, and a dead session writes nothing

**Source:** stated when the detector was built, recorded so it is not rediscovered as a defect.

Injection is automatic; writing is not. A session that runs to 140K and is closed without
anyone invoking `session-handoff` leaves nothing to inject, and the hook cannot write the brief
itself — a deterministic script has no model. The detector makes saving cheap; it does not save.

Two mechanisms exist and were both rejected for now, with reasons, because the next person to
notice this will reach for them. `Stop` can exit 2 to refuse to end a turn until a brief exists,
and `UserPromptSubmit` can exit 2 to refuse new work in a spent window: both are blocking hooks
in a repository whose own `format-changed.mjs` says a hook that can fail a task is a hook that
gets disabled, and both need a marker file to avoid nagging forever. `PreCompact` fires before
auto-compaction and could dump a mechanical snapshot — branch, HEAD, `git status --porcelain`,
the last few assistant turns — which is not a brief but is better than nothing.

**Trigger:** the first time real work is actually lost this way. Not before — the cost of the
gap is currently a guess, and a blocking hook installed against a guess is how the whole
mechanism gets turned off.

---

## Discovered while reproducing DoD #9 (2026-08-16)

Workflow `dod9-routing-repro`, seven agents on throwaway branch `dod9-repro`. Full evidence in
`.artifacts/phase1-validation-2026-08-16.md`. #9 passed; three things it surfaced are recorded
here rather than acted on.

### `pnpm check:routing` — make the seeded-defect run permanent

**Source:** council verdict on #9, 2026-08-16; deferred there, unchanged by the run.

#9 cost seven agents, 852s and 242K subagent tokens to prove once. A permanent script holding a
small set of seeded defects — each with the assertion that does _not_ catch it — would re-prove
the routing chain every phase at near-zero marginal cost, and would catch the case where a new
test accidentally makes a seed visible (which is itself a signal worth having).

Deliberately **not** built during #9: it is scope expansion on the item being negotiated for
cost, and a suite generalising from one sample would encode that sample's accidents. The run
also left the retry path untested — the loop-back for an over-obvious seed never fired, because
attempt 1 was already silent — so the one branch a permanent suite most needs has no exercise
behind it.

**Trigger:** build it when a second seeded-defect run is wanted for any reason. Two samples is
the minimum from which a shape can be abstracted; one is a transcription.

### Misrouting under parallel dispatch is uncovered — blocks parallel in Phase 2

**Source:** council caveat on #9, 2026-08-16; confirmed unaddressed by the run.

#9 proved routing at **N=1, sequential, single worktree**. The actual Phase 2 risk is different:
several lanes in flight at once, each producing handoffs, and a handoff reaching the wrong lane
or a lane acting on another lane's finding. Nothing in #9 touches that.

`pnpm lanes decide`'s fifteen requirements gate **whether** a batch may go parallel. None of
them test whether **routing survives concurrency** — that is a different question wearing
similar clothes, and R3/R7/R10 passing is not evidence for it.

**This item blocks parallel dispatch in Phase 2** (human decision, 2026-08-16). Sequential
dispatch is unaffected and remains the documented default, so this blocks nothing that is not
already an exception a batch has to earn.

**Trigger:** the first batch that `pnpm lanes wave <phase>` returns `parallel` for. Prove
routing across ≥2 concurrent lanes before that batch dispatches — a second seeded defect, in a
second worktree, checking that each handoff reaches its own lane and no other.

**Shape settled 2026-08-16** (human decision). Both expensive extremes were rejected: neither a
full parallel-routing programme nor a blanket sequential Phase 2. The trial is **minimal** —
one run, two worktrees, two **disjoint packages**, after `p2.shared-schema` completes solo.
Later collision-free work parallelises only if all five hold:

1. both tasks route correctly,
2. commits remain independent,
3. integration is conflict-free,
4. all tests pass,
5. coordination cost is below the projected elapsed-time saving.

Criterion 5 is the one with no instrument — `pnpm lanes decide` has no cost model
(see _`pnpm lanes decide` has no cost model_ above), so it is a judgement made in the open
rather than a measurement. Say which it was.

The `api`-lane collision in wave 3 (`p2.ingest-endpoint` + `p2.runs-api`, flagged by
`pnpm oracle waves`) is **serialised regardless of the trial's outcome.** R7/R8 do not catch
it because the collision is directory-level, not file-level.

### `onModuleInit` reports a connection it never verified

**Source:** Validator, during #9 detection. `.artifacts/dod9/handoff.json`, evidence entries 1-3.

`PrismaService.onModuleInit` calls `$connect()` and then logs `Database connection established`.
Under Prisma 7.9.1 with `@prisma/adapter-pg`, `$connect()` **does not reject** for an unreachable
database. Reproduced against an unreachable host, a non-existent domain, a malformed URL and
wrong credentials — all four log success and resolve with `threw:false`, while the same client
reports `isReachable(): false` one line later.

`docker-compose.yml:44-46` documents the opposite contract — _"the API validates its environment
and connects at boot, so starting it against a Postgres that is merely running produces a restart
loop."_ That restart loop cannot happen. The API boots reporting itself alive against a database
it never reached.

This is **on `main`**. It was not introduced by the #9 seed; the seed sat on top of it, and the
Validator flagged the distinction unprompted in its `unknowns`.

A fix exists and is **already written**, on branch `dod9-repro` — a `$queryRaw\`SELECT 1\``round-trip after`$connect()`, with the failure allowed to propagate. `git diff main..dod9-repro`
is exactly that change and nothing else. **The branch is deliberately not deleted.**

Not carried to `main` unilaterally: it is production code outside the change that found it, and
`CLAUDE.md` puts that decision with the human. Note that `pnpm gates` is green either way — the
defect is invisible to the current suite, which is why #9's seed could hide behind it. Whoever
takes it should add the `prisma.service.spec.ts` case the seed record names, or it stays
invisible after the fix too.

**Open question this does not answer:** whether the health endpoint's steady-state
`isReachable()` posture ("report, don't fail") was meant to extend to boot. The Validator's
`recommendedNextAction` lays out both readings and declines to pick. Someone has to.

**Addressed 2026-08-16** by `e149c86`. The open question was decided in favour of reading (a):
boot fails loudly, steady-state reports. `docker-compose.yml:44-46` already documented that
contract and the code contradicted it, so the code moved. `isReachable()` is unchanged and
keeps the opposite posture on purpose — the two postures are now each stated in a comment at
their own site, because the next reader will otherwise "fix" one to match the other.

Reapplied cleanly rather than merged, with the coverage `dod9-repro` never had:
`prisma.service.spec.ts` over three seams (call order, propagated rejection, absence of the
success log), mutation-proven — including against the exact `try/catch` shape of the #9 seed,
which the suite was blind to before — and `prisma-boot.integration.spec.ts`, one bounded
real-adapter check against a closed port, no container, 442ms. That check found no gap, so no
Compose or restart-loop work was started. Evidence:
`.artifacts/phase1-validation-2026-08-16.md`, _Fix carried to main_.

Branch `dod9-repro` is deleted; the archive is tag `archive/dod9-repro` plus
`.artifacts/dod9/{ARCHIVE.md,dod9-repro.bundle,dod9-repro.patch}`.

---

## Discovered while framing 5a (2026-08-16)

The execution order was amended at the Phase 1 gate — see the amendment in `MVP_PLAN_V3.md`
Part III. 5a is Phase 5 waves 1–3, pure functions over fixtures, and runs before Phase 2.
Everything below was surfaced during that framing and is **not** required by the 5a
Definition of Done.

### Two test packets are self-graded — and three are not

**Source:** council finding in `.artifacts/plans/phases-2-7-execution-plan.md` §6b, then
checked against `scripts/oracle/graph.json` on 2026-08-16.

The council named `p2.integration-tests`, `p6.seed-repro` and "all of Phase 7 wave 1" as
packets where Validator authors the evidence and then issues the verdict on it. **Only two of
those are true.** `p2.integration-tests` and `p7.e2e` own `platform/api/test/**`, so Validator
writes the test code. `p6.seed-repro`, `p7.regression` and `p7.docker-smoke` own `.artifacts/**`
only — they run documented commands and write a report, which is what a validator is for. Do
not "fix" the last three; nothing is wrong with them.

The fix for the two real ones is mechanical and adds two nodes: flip `owner` to `builder`,
then add `p2.integration-falsify` and `p7.e2e-falsify`, each owned by `validator`, allowed
`.artifacts/**` only, `needs` the packet it grades. This matters most at **E2E 4**, the silence
case — the test that is supposed to prove the product has judgment is the one that must not be
graded by whoever wrote it.

Deferred out of 5a because these are Phase 2 and Phase 7 packets and §8 forbids expanding the
active phase. 5a's own separation already holds without any change: `p5.negative-fixtures` owns
`fixtures/** test/**` and the analyzer packets own `src/**`, so an analyzer Builder physically
cannot edit the fixtures it must satisfy.

**Trigger:** the Phase 2 frame. Do it before `p2.integration-tests` is dispatched, not after.

### Council findings deferred out of 5a

**Source:** `.artifacts/plans/phases-2-7-execution-plan.md` §6b, five-advisor council plus peer
review, 2026-08-16. Full reasoning lives there; this entry exists so the items are not lost
between now and the phase that owns each one.

- **Per-lane `DATABASE_URL`.** R9 compares file paths, so two lane worktrees sharing one
  Postgres is an undeclared shared write surface and `check-lane-ownership.mjs` cannot see it.
  _Does not apply to 5a — nothing in it touches a database._ **Trigger:** the first wave that
  runs a migration alongside any other lane, i.e. Phase 2 wave 2 (`p2.prisma-run-step`).
- **`pnpm lanes worktrees` prints a comment, not a command.** It emits `current.json` as a `#`
  block for a human to hand-type. No lane file means no enforcement, silently — the worst
  available failure mode. Roughly five lines in `scripts/lanes.ts` case `'worktrees'`.
  _Does not apply to 5a — its waves are 1, 1 and 2 packets and the last two collide on
  `src/**`, so it is sequential with no worktrees._ **Trigger:** the first worktree.
- **The repair loop has no ceiling.** "One bounded repair attempt" never defines bounded, and
  re-validates only the failing criterion. Proposed: bounded = one Builder dispatch; re-run the
  whole DoD after any repair; hard stop to the human after two Diagnostician cycles on one
  criterion. **Trigger:** the first repair, in any phase. Cheap enough to settle at the 5a gate
  if one occurs.
- **Tester contradicts its own agent file.** `.claude/agents/tester.md` says rare and never per
  packet; the delivery plan schedules Tester (opus) on every behavior-class wave, and Phases 3,
  5, 6 and 7 are almost entirely behavior class. Pin it to phase gates. **Trigger:** the 5a
  gate — 5a _is_ a phase gate, and it is the thesis-critical one, so Tester running there is the
  intended case rather than the cost problem.

  **Amended 2026-08-16, 5a step 0.** "Pin Tester to phase gates" stands. The last sentence does
  not. `docs/decisions/0004-no-tester-at-the-5a-gate.md` skips Tester at the 5a gate specifically,
  on a ground this bullet never weighed: 5a has no running system for Tester to attack, so its
  job there reduces to shifting thresholds, which is a threshold-binding spec. The exception is
  narrow and paid for — if that script is not landed by the gate, Tester runs. Tester returns at
  the 5b gate, where the analyzer sits behind an endpoint.

- **`docs/PARALLEL_EXECUTION.md` §2 is stale.** It says Validator ships as `opus` and recommends
  `sonnet`; `.claude/agents/validator.md` already says `sonnet`. Documentation only.
- **`env.docker`'s note in `graph.json` is stale.** It reads "BACKLOG.md records Docker + WSL2 as
  not installed", which this file resolved on 2026-08-16. `pnpm oracle unblock` therefore reports
  a phantom root cause and `oracle status` still shows Phase 1 at 10/14. Two-line fix, deferred
  only because it is outside the 5a change.
- **The delivery plan is unreadable to a stranger.** R1, R6, R9, R11, R12, R15, OD-5, §23, G2 and
  D4–D9 are cited as load-bearing and defined nowhere in that file. Add a one-line gloss at first
  use. **Trigger:** `p7.readme`, where the portfolio-reader audience becomes the point.

---

## Discovered computing the gate expectation grid (2026-08-16, 5a step 0)

Two agents independently computed a five-gate grid over `D1`–`D9` from the raw fixture inputs,
with `spike/aggregate.ts`, `spike/gates.ts` and the fixture `expect` blocks withheld. Both
grids agree cell for cell. Provenance and full findings:
`.artifacts/evidence/5a/gate-expectation-grid.md`.

Two of the findings were absorbed into 5a because each was the only way to verify a Definition
of Done item that already existed — `D10` for "names every failing gate", `D11` for
"`attestedSuccessRate` is null, never 0". The four below are not required by any Definition of
Done item and are deferred.

### No fixture sits on a gate threshold — ABSORBED INTO 5a, 2026-08-17

**Source:** both grid computations, independently.

**Status: no longer deferred.** A council review found that ADR 0004's threshold-binding spec
cannot fail against a corpus that never sits on a threshold, so the spec would have paid for
skipping Tester with a green that could not go red. The fifteen `B1`–`B5` groups in
`MVP_PLAN_V3.md` Phase 5, **Threshold boundary rows**, close this entry: `29/30/31` samples,
`4/5/6` contexts, and `89.9/90.0/90.1%` on all three ratio gates. Provenance:
`.artifacts/evidence/5a/threshold-boundary-rows.md`. The original entry is kept below because
its reasoning is what the absorption rests on.

Sample counts across the whole corpus are 12, 24, 26, 40, 45, 50, 50, 50, 60 — never 30.
Distinct-context counts are 2, 8, 8, 9, 10, 10, 11, 12, 15 — never 5. No ratio equals 0.90 or
0.80. Every fixture sits far from every threshold, so `>=` versus `>` is untested across the
entire suite and an off-by-one in any comparison operator is invisible.

Wanted: `29 / 30 / 31` samples and `89.9% / 90.0% / 90.1%` dominance, six small groups. Cheap,
and cheapest now while the analyzer is pure functions with no persistence around it.

Deferred because no 5a Definition of Done item asserts the comparison operator, and §8 forbids
expanding the active phase. The threshold-binding spec (ADR 0004) partially covers the same ground by
shifting each threshold one unit — it would catch a `>` written as `>=` at a shifted threshold,
but not a fixture corpus that never binds. **Trigger:** 5b, or `p7.regression`, whichever comes
first. If the threshold-binding spec ever reports that a threshold can move without flipping any
verdict, do it immediately instead.

### `spike/fixtures/decisions.json` declares a `$schema` that does not exist

**Source:** grid computation A.

The file declares `"$schema": "./decisions.fixture-format.md"`. `spike/fixtures/` contains only
`decisions.json`. Either the format spec was never written, or it was deleted, or it lives
elsewhere under another name. A pointer to nothing is worse than no pointer — it reads as
though the expansion semantics are documented somewhere.

Matters at graduation: the fixture rows are run-length encoded with an implicit round-robin
`contextKey` assignment, and that expansion rule is currently inferred from a `$comment` plus
`spike/expand.ts`. **Trigger:** `p5.negative-fixtures`, which graduates these fixtures. Either
write the format note or drop the `$schema` key.

### The round-robin `contextKey` cursor scope is unspecified

**Source:** both grid computations, independently, as an open question.

When a fixture row omits `contextKey`, keys are dealt round-robin from the group's `contexts`
array. Whether the cursor resets per row or runs continuously across the group's `decisions`
list is written down nowhere.

**Provably immaterial today.** One of the two agents tested all three plausible semantics and
every `distinctContextKeyCount` is identical under all three, because in every group the
largest unkeyed row's `count` is at least `contexts.length`. It stops being immaterial for any
future fixture whose dominant row is smaller than the context list — which the threshold
fixtures above would be. **Trigger:** whichever lands first, the boundary fixtures or the
format note.

**The trigger has fired (2026-08-17).** The boundary groups land in `p5.negative-fixtures`.
Their own cursor is pinned in the plan — round-robin over the pool, in order, from the pool's
first entry — and every boundary group has more decisions than pool entries, so their
`distinctContextKeyCount` is invariant again. What still has no written rule is the cursor over
the run-length-encoded `D1`–`D9` rows that the same packet graduates. Settle it there.

### Two fixture `rationale` strings quote a blended success rate

**Source:** grid computation A.

`D7`'s rationale says "a 96.7% success rate" — that is 29/30 across both options. The dominant
option's own rate, which is what `G4` evaluates, is 28/29 = 96.55%. `D9`'s says "a 93% success
rate", which is 40/43 blended; `YES` alone is 25/26 = 96.15%.

Neither flips a gate, and both fixtures suppress on other grounds. The risk is narrower and
real: §19 exists partly to forbid exactly this blend — "a blended success rate across all
options can clear the gate while the option being recommended is the one that fails" — and
these two strings encode the forbidden blend in prose sitting next to the numbers. Anyone
sourcing an expected value from the rationale rather than the grid inherits it.

Deferred because the fixture-provenance rule already forbids sourcing an expectation from
anywhere but the plan's tables, so the strings are inert as long as that rule holds. **Trigger:**
`p5.negative-fixtures`, when these rationales are graduated into
`platform/analysis-engine`. Correct them to the dominant-option rate, or delete the number
from the prose.

---

## Discovered reviewing an external method against the harness (2026-08-16)

Full review: `.artifacts/reports/matt-pocock-kb-review-2026-08-16.md`. Source note:
`docs/research/2026-08-16-matt-pocock-ai-engineering.md`. The review closed two gaps
directly — research notes and ADRs now have homes — and left these three.

### An outside method agrees that lane cost is unmeasured — and it does not move the trigger

**Source:** review of `docs/research/2026-08-16-matt-pocock-ai-engineering.md`, 2026-08-16.

The note's §11.1 lists `tokenCost` and `elapsedMs` as required per-iteration fields, and
§15 lists "context health and token-cost telemetry" as a thing to build. This repository
already knows: **`BACKLOG.md:249`** (R12's "benefit exceeds overhead" is a count heuristic
over an unmeasured quantity, deferred behind ≥20 dispatched batches with ≥5 parallel) and
**`BACKLOG.md:655`** (`UserPromptSubmit` does not fire inside a subagent, so the
Coordinator never learns what a packet cost; fix named as a `SubagentStop` hook appending
`usage` to `.artifacts/telemetry/lanes.jsonl`).

Both entries stay deferred on their existing triggers. The reason is the point of this
entry: §11.1 and §15 are labelled **"El/LenGentic extension"** in the note's own text.
They are this repository's output, not outside evidence. Reopening a named deferral on the
strength of a mirror is how a trigger quietly stops meaning anything.

**Trigger:** unchanged — whichever of `BACKLOG.md:249` or `:655` fires first. This entry
adds no new one.

### Dogfood the harness through the product's own schema

**Source:** review of `docs/research/2026-08-16-matt-pocock-ai-engineering.md` §11.1,
2026-08-16.

That section's per-iteration record — `runId`, `workflowVersion`, `contextKey`,
`parentEvidenceIds[]`, `tokenCost`, `status` — is LenGentic's product model pointed at
LenGentic's own delivery harness. A dispatch decision is an `execution_strategy` Decision
(§29). A lane handoff is an attestation. `pnpm lanes decide` is a deterministic evaluator.
The shapes already line up because both were designed by the same person for the same
reason.

Value if built: the harness becomes a telemetry source that is **structurally independent**
of the Playground, which is exactly what the existing entry _One structurally independent
attestation in the demo_ asks for. A portfolio reader sees the product observing its own
construction.

Cost: it is a second instrumented system to maintain, and `.claude/**` is in `graph.json`'s
`alwaysForbidden` list precisely so the harness and the product stay apart. Wiring product
telemetry into the harness is not a small architectural question — it may violate the
boundary that `pnpm check:isolation` exists to protect.

**Trigger:** `p7` portfolio work, and only if `p6` scenarios have not already produced a
structurally independent attestation source. Not before Phase 5 makes the analyzer real.

### `CLAUDE.md` is 187 lines and pays that on every turn

**Source:** review of `docs/research/2026-08-16-matt-pocock-ai-engineering.md` §3.4 and
§4.1, 2026-08-16.

The note's rule for an always-loaded file is a one-sentence description, the non-default
package manager, non-standard commands, and "only rules relevant to virtually every task".
`CLAUDE.md` carries twelve sections. Several bind narrowly: **Types** binds work crossing a
module boundary, **Product claims** binds analyzer and recommendation work, **Dispatch**
binds the Coordinator at a wave boundary. A session that runs one command and reports the
result pays for all three.

The instrument is the note's §4.1 no-op test: if deleting a sentence would not change agent
behaviour, delete it. The counter-rule from the same section is why nothing was cut here —
"Do not shorten useful behavior into ambiguity; delete no-ops rather than merely
compressing wording." A line count is not evidence that a rule is a no-op.

Recorded rather than acted on because the audit is judgement, not a script, and because
moving a rule behind a pointer trades context load for the risk that it stops being read.

**Trigger:** the first time a session demonstrably misses a `CLAUDE.md` rule that was in
context the whole time — that is evidence of dilution, and dilution is the argument for
cutting. Or `p7.readme`, where the file gets a stranger-facing pass anyway.

### `agent-activation.json` says "Disjoint by construction" and two pairs are not

**Source:** role-existence audit of the nine agents, 2026-08-16.

`$responsibilitiesComment` opens with "Disjoint by construction." Two pairs are not:

```text
runner    [command-execution, raw-evidence, exit-codes]
validator [command-execution, raw-evidence, exit-codes, adversarial-cases,
           false-green-detection]          -> runner is a strict SUBSET of validator

tester    [adversarial-cases, false-green-detection, negative-coverage]
validator                                  -> two of tester's three are validator's too
```

`scripts/lanes/selftest.ts:383` scenario 11 is the only disjointness assertion, and it
compares **reviewer against watchdog only**. Nothing checks the other thirty-four pairs, so
the sentence claims a property the harness does not test.

**The overlap is correct and must stay.** Three lines above, `$capabilitiesComment` explains
why: capabilities resolve to "the FIRST agent file that exists", so
`execute: [runner, validator]` and `adversarial-test: [tester, validator]` make `validator`
the deliberate fallback for both. Deleting `runner.md` and `tester.md` collapses the roster
to §21's four-agent shape with no other edit — which is exactly the reversibility
`docs/decisions/0001-nine-agent-roster.md` relies on for its detection condition.

So the defect is the sentence, not the data. "Disjoint by construction" should read as what
is actually true: reviewer and watchdog are asserted disjoint; validator deliberately
supersets runner and tester so the roster can collapse without a rewrite. As written, a
future reader who takes the comment at face value could "fix" the overlap and silently
remove the fallback.

Documentation only — no behaviour changes either way. Deferred because it is outside the
review that found it, not because it is uncertain.

**Trigger:** the next edit to `.claude/rules/agent-activation.json` for any reason, or the
`reflector` pass that evaluates whether the nine-agent roster earned its keep — that pass
reads this exact block.

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

## Discovered at the 5a pre-dispatch step (2026-08-17)

### The lane-ownership hook blocks scratchpad writes

**Source:** boundary grid computation A, unprompted, mid-task.

`.claude/hooks/check-lane-ownership.mjs` rejected a write to the session scratchpad — a path
outside the repository entirely — as being outside lane `p5.engine-pkg`'s surface. The agent
worked around it through Bash and disclosed the incident.

Any agent that uses the scratchpad while a lane file is present hits this, and the workaround
is "use a different tool", which is exactly the shape that gets a hook switched off. A path
that resolves outside the repository is not the lane's business either way. **Trigger:** the
Phase 1 debt wave, alongside the pre-commit hook work, since both touch `.claude/hooks/`.

### An oracle probe can report a packet DONE before it starts

**Source:** the 5a pre-dispatch review, confirmed against `pnpm oracle waves` output.

`p5.det-candidate` probed `grep minorityContextConcentration` and `p5.repeated-failed` probed
`grep inputFingerprint`, both over `platform/analysis-engine`. Wave 1 graduated the types, so
`src/types.ts` and `src/tool-call.ts` satisfied both patterns the moment wave 1 merged. Both
wave-3 packets read `DONE` in `pnpm oracle waves` while neither had been written, and
`pnpm lanes wave 5` batched two 5b packets in their place.

Fixed for those two by probing paths only a wave-3 packet can create. The class of defect is
not fixed: a probe whose pattern an _earlier_ packet also satisfies is a false green, and
nothing checks for it. **Wanted:** a selftest scenario in `pnpm check:lanes` or a lint over
`graph.json` that flags any `grep` probe whose pattern already matches at the time its own
blockers complete. **Trigger:** before the first Phase 2 parallel wave, which is the first time
a wrong wave shape costs more than one dispatch.

**Addressed 2026-08-17** by `pnpm check:probes` (`scripts/lanes.ts probes`), on a narrower and
more checkable rule than the one wanted above: **a probe may only look inside the surface its
own node owns.** No history simulation is needed — the two broken probes named
`platform/analysis-engine`, which is not inside `src/**` or `test/analyzer/**`, and that is
statically visible.

It found eight more nodes with the same defect on its first run. Every Phase 3 node grepped the
whole of `playground` while owning one directory inside it, so the first sibling to land would
have marked the rest done — Phase 3 would have collapsed to one packet exactly as Phase 5
collapsed to none. All eight are narrowed. Red-then-green proof, including the wave shape the
lie produced: `.artifacts/evidence/5a/oracle-lint-proof.md`.

Runs in CI beside `check:lanes` and `check:kb`, and out of `pnpm gates` for the same reason.
What is **not** covered: a `grep` probe whose pattern is satisfied by an earlier deliverable
inside the node's _own_ surface. `p5.engine-pkg` owns `platform/analysis-engine/**`, so a
future node sharing that surface could still be probed loosely. The `WARN` on grep-only nodes
is the hint; 35 nodes currently carry it.

### `D10` fails two count gates, never a count gate and a ratio gate

**Source:** the adversarial fixture-semantics review, 2026-08-17.

`D10` exists to catch `failedGates = [firstFailure]`, and it does: 12 samples over 2 contexts
fails `G1` and `G2` together. Both are integer-threshold gates. An implementation that
evaluates every count gate but short-circuits inside the ratio gates `G3`/`G4`/`G5` passes
`D10` unharmed, because `D10` has no failing ratio gate.

Wanted: a row that fails one of each — 12 samples, 8 contexts, 60% dominance fails `G1` and
`G3` — as a strictly stronger discriminator at the same cost. Deferred because the Definition
of Done asks that every failing gate be named and `D10` already makes that falsifiable;
swapping the shape now would rewrite a grid row that two independent computations agreed on.
**Trigger:** 5b, when the analyzer goes behind `POST /v1/analysis/run` and the fixture corpus
is revisited anyway.

### Cited evidence lives in a git-ignored directory

**Source:** the 5a pre-dispatch commit, 2026-08-17.

`MVP_PLAN_V3.md` cites `.artifacts/evidence/5a/gate-expectation-grid.md`,
`.artifacts/evidence/5a/threshold-boundary-rows.md` and
`.artifacts/evidence/5a/fixture-semantics-review.md` as the provenance of the only legal source
of expected values, and `docs/decisions/0004` is paid for by
`.artifacts/evidence/5a/threshold-binding-mutation.md`. `.gitignore:15` excludes `.artifacts/`
entirely, so a clean clone has the citations and none of the evidence.

The convention is deliberate — `CLAUDE.md` says to store detail in `.artifacts/` and return
paths — and it is right for run logs and scratch. It is wrong for the handful of documents the
plan of record cites as provenance. **Wanted:** either a tracked `docs/evidence/` for cited
provenance, or a `.gitignore` exception for `.artifacts/evidence/**`. **Trigger:** the 5a gate,
where a human is asked to accept ADR 0004 as paid on the strength of a file that is not in the
repository.

## Discovered building the negative fixture suite (2026-08-17, 5a wave 2)

### No `R` fixture binds the "or records an Error" half of §20.2

**Source:** the wave-2 Builder, which could not file it — `BACKLOG.md` is outside its lane.

§20.2 emits when the result is `FAILED` **or** records an Error. Every one of `R1`–`R5`
expresses failure through `outcome` alone; none has an `outcome: SUCCESS` row carrying a
non-null `errorType`. A wave-3 implementation that reads `outcome` and ignores errors passes
all five, and half the condition graduates unexercised.

This is the same shape as the `D10`/`D11` findings — a Definition of Done sentence with no
fixture that can falsify it — but it differs in one way that decides the disposition: the 5a
Definition of Done asks that `R4` and `R5` both emit, and it does **not** assert the error
branch. Absorbing it would mean reopening `fixtures/**` after the wave that owns it has merged
and been hashed, which is the one thing the wave split exists to prevent.

So it is deferred, and the cost is named instead of hidden: `p5.repeated-failed` is briefed to
implement both halves, and nothing in 5a can prove it did. **Trigger:** 5b, where the analyzer
goes behind `POST /v1/analysis/run` and the fixture corpus is revisited anyway — or
`p6.scenario2`, if that scenario produces a tool call that errors without a `FAILED` outcome,
whichever comes first.

## Discovered while auditing how decisions are recorded (2026-08-17)

### `pnpm decide` — one generated index over the six decision stores

**Source:** human instruction, 2026-08-17 — "stop asking trivial functional questions; build a
decision workflow from our decision graph." Research and prior art:
`.artifacts/reports/decision-system-research-2026-08-17.md`. Full plan:
`.artifacts/plans/pnpm-decide-plan.md`.

Decisions live in six places — `docs/decisions/`, `scripts/oracle/graph.json` `decisions[]`,
`BACKLOG.md`, `CONTEXT.md`, `MVP_PLAN_V3.md`, and `.artifacts/telemetry/lanes.jsonl` — and
nothing joins them. ADR 0004 overturns a `BACKLOG.md` entry in prose with no edge recording it.
`OD-3` is `"answered": true` and does not say what was answered. Nothing answers "has this
already been decided?" before a question is asked, which is how a settled question reaches a
human as a fresh one.

**Ruled out, so it is not re-litigated.** No vector database and no RAG. The corpus is ~100
records under 50k tokens changing a few times a week; below roughly 500 documents retrieval is
overhead, and an embedding is not a mechanical check. No new store, no service, no MCP server,
no write path — the tool is generated and read-only.

**Named risk.** A loose match that answers "already decided" silences a question that should
have been asked. That is `check:probes` one layer up. `NOVEL` is the default below the
confidence floor, hits carry `file:line` and never a paraphrase, and the negative fixtures are
written before the positive path.

**Blocked on** the gitignored-evidence question already filed above — an index that cites
`.artifacts/evidence/**` would ship citations to files no clone contains.

**Trigger:** after the 5a gate. It is not in any 5a Definition of Done, and building it now
would expand the phase.

**Built ahead of the trigger** — human instruction, 2026-08-17, overriding the trigger above:
"it's not related to 5a development but I need it to make the development faster." Landed as
`scripts/decide.ts` + `scripts/decide/selftest.ts` (`pnpm decide`, `pnpm check:decide`), 26
scenarios, confidence-floor mutation-checked (`.artifacts/evidence/decide/floor-mutation.md`).
Scope narrowed to sidestep the gitignored-evidence block rather than answer it: five of the
six stores are tracked files, cited `file:line` against themselves; `cites-evidence` edges into
`.artifacts/evidence/**` are not built, for the reason stated above. Telemetry
(`.artifacts/telemetry/lanes.jsonl`) is read as a live, best-effort local signal, gitignored
and all — its absence is a clean tree, not a parse failure. `pnpm decide build` regenerates
on every invocation rather than committing an index, which was the open question in the plan's
§9.2 and is now answered by construction. `pnpm gates` could not be fully re-verified green at
land time — `platform/dashboard`'s `next build` reported "Another next build process is already
running", pre-existing and unrelated to this change (nothing imports `scripts/decide.ts`);
lint, typecheck, test, `check:boundaries` and `check:integrity` all ran green. Full plan:
`.artifacts/plans/pnpm-decide-plan.md`.

### The four-gate ladder is adopted now, without the tool

**Source:** same instruction. The procedure half of the proposal needs no code.

Before any question reaches the human: Gate 0 — a script decides it, so run it and cite the
output. Gate 1 — already decided, so apply it and cite `file:line`. Gate 2 — blocks a
deliverable, so escalate _framed_: cost asymmetry, named rejected alternatives, a
recommendation, and the Detection that would show it wrong. Gate 3 — novel, costly and blocking
nothing, so council or Architect, then an ADR. Otherwise state the assumption and act.

Recorded here because it is a working agreement, not a deliverable, and because the failure it
prevents already happened: the wave-3 dispatch was put to a human as "A or B?" when
`pnpm lanes wave 5`, the council verdict and ADR 0002 had each already answered it. **Trigger:**
none — in force from 2026-08-17. It becomes `pnpm decide`'s specification when that lands.

## Discovered at the 5a validation gate (2026-08-18)

### `MIN_CONSECUTIVE_FAILURES` is the one threshold with no injection path

**Source:** independent threshold-injection audit at the 5a gate —
`.artifacts/evidence/5a/threshold-injection-audit.md`. Found while verifying
`MVP_PLAN_V3.md:2217-2218`, "every threshold is injected rather than read from a module-level
constant".

`src/repeated-failed-action.ts:33` holds `const MIN_CONSECUTIVE_FAILURES = 3`, and
`detectRepeatedFailedActions` takes no config parameter. No test binds a different value, so
unlike the five gate thresholds this one cannot be shifted to prove a comparison is really
bound. The five gate comparators are clean: they read `config.*` only, `countGate`/`ratioGate`
take `threshold` as a bare argument with no fallback, and nothing in `src/gates.ts` references
`DEFAULT_CONFIG`.

Deferred because the 5a checkbox is scoped by its own acceptance criterion at
`MVP_PLAN_V3.md:2219-2222`, which names **the five gate comparisons** and nothing else, and
because §20.2 states "three consecutive" as a fixed condition of the pattern rather than as a
tunable. Under that reading `MIN_CONSECUTIVE_FAILURES` is part of the definition of a repeated
failed action, not a threshold on one. **Assumption recorded, not escalated** — the competing
reading of "every threshold" would widen 5a's scope, and the acceptance criterion is the tighter
authority.

Worth doing when a deployment wants to tune the streak floor, or when a `B6` boundary group is
wanted for §20.2 the way `B1`-`B5` exist for the gates. Ruled out already: moving it into
`AnalyzerConfig` now, because that changes a frozen 5a type after both analyzer packets landed
and buys nothing the current DoD asks for.

### Conflation detection is shape-identity, not provenance

**Source:** Builder's own stated risk on bounded-recovery attempt 2, commit `5af3b87`, at the 5a
gate. Evidence: `.artifacts/evidence/5a/minority-context-concentration-conflation-mutation.md`.

`conflatedWithCounterexamplesProblems()` (`test/grid/assert-against-grid.ts:309`) catches a
`minorityContextConcentration` conflated from `counterexamples` only when the two per-context
groupings are **exactly identical**. A conflation that adds or drops one entry, or that merges a
real minority-`FAILURE` row in alongside the wrong ones, would not trip it. That is enough to
bind `MVP_PLAN_V3.md:2213` and enough to reproduce the validator's attack on `D7` and both `D8`
rows, which is what the packet was opened for.

Deferred because the general fix is provenance tracking on `ContextConcentration`, and that is a
type change in `src/**` — outside the recovery packet's `allowed_paths`, and a frozen 5a type
after both analyzer packets landed. Ruled out already: widening the packet's paths to do it
anyway. Worth doing if 5b's rendering work reopens `ContextConcentration` for another reason.

### `gates:full` on every commit costs minutes, dominated by isolation Arm 1

**Source:** Builder's `follow_up_required` on `p1.debt.precommit`, commit `4876287`, Phase 1
carried debt. Evidence: `.artifacts/evidence/1/precommit-hook-proof.md` and the four `.log`
files beside it.

`.husky/pre-commit` runs `pnpm gates:full`, so every commit pays `check:isolation` Arm 1 — a
full `pnpm install` + build + test in a temp checkout with `playground/` removed. Coordinator
re-measured it independently at `4876287`: `pnpm gates` exit 0 and `pnpm check:isolation` both
arms PASS, but Arm 1 is the multi-minute term and it answers a question whose answer changes
only when an import changes.

Implemented as specified on purpose. `MVP_PLAN_V3.md` §7 names `gates:full` the pre-commit
tier, and "do not redesign the approved MVP while implementing it" governs — the lane's job was
to build the tier the plan names, not to pick a cheaper one.

Worth doing when the cost is actually felt: cache the Arm 1 install, or gate Arm 1 on whether
the diff touches an import or a manifest, leaving `pnpm gates` on every commit and the full arm
on push and in CI. Ruled out already: substituting `pnpm gates` for `gates:full` in the hook,
which silently retires the only enforcement of §4's isolation contract and reads as green.

Not filed: the Builder's second candidate, a worry that `.husky/prepare.mjs`'s `existsSync('.git')`
guard might miss git worktrees. It does not — in a worktree `.git` is a file, and `existsSync`
is type-agnostic. No gap, so no entry.

### The secret scanner cannot see a secret staged into the scanner itself

**Source:** Coordinator review of `p1.debt.secrets`, commit `40f1643`, Phase 1 carried debt.
Evidence: `.artifacts/evidence/1/p1.debt.secrets.md`, and `scripts/check-secrets.ts:78` —
`scanLine()` returns early on `file === SELF_PATH`, and `scanTree()` skips the same path.

`scripts/check-secrets.ts` holds seven credential-shaped pattern literals, so it would flag
itself on every run. The lane solved that with an explicit path allowlist and said so in its own
header: "the honest fix is 'don't scan the scanner', not 'weaken the pattern so it can't see its
own definition'." That call is right, and the alternative — filing the patterns down until they
no longer match themselves — would have degraded detection everywhere to fix one file.

The residue is that **both** modes skip the file, so a real credential pasted into
`scripts/check-secrets.ts` is invisible to staged-diff mode and to `--sweep` alike. One file in
the repo is unscannable, and it is the file a future maintainer edits while thinking about
secrets.

Small, and not urgent: the surface is one file that only changes when the pattern set changes.
Worth doing if the scanner grows past its current single file — scan self but skip only the
lines between explicit `check-secrets:allow-start` / `-end` markers around the `PATTERNS` array,
which shrinks the blind spot from a file to a block. Ruled out already: dropping the allowlist
without a replacement, which makes every run red and trains everyone to `--no-verify`.

### Secret detection is a curated pattern set, not entropy analysis

**Source:** Builder's `follow_up_required` on `p1.debt.secrets`, commit `40f1643`, Phase 1
carried debt.

`scripts/check-secrets.ts` matches seven named vendor token formats — AWS access key ID, GitHub,
Slack, Google API key, OpenAI/Anthropic-style `sk-`, PEM private-key block, JWT shape. Verified
live: all seven fire on a planted fixture, and a full `--sweep` over every tracked file reports
0 findings, so the set costs no false positives today.

What it does not catch is a high-entropy string with no recognizable vendor prefix — a database
URL with an inline password, a bare 40-character hex API token, a `.pem` pasted without its
header. A first-draft generic Bearer-token pattern was cut during the build precisely because it
false-positived on `scripts/lanes/selftest.ts:1116`, an existing structured-logging redaction
fixture. That is the real trade-off, not an oversight.

Deferred because the honest upgrade is `gitleaks` or `trufflehog`, which needs either an npm
dependency (`package.json` and `pnpm-lock.yaml` are outside this packet's `allowed_paths`) or an
external binary every developer and CI runner must install. Worth doing when telemetry payloads
with credential-shaped fixtures start landing in Phase 2, which is the point OD-6 itself names as
the reason this could not wait.

## Discovered designing the cross-reference checker (2026-08-18)

### Defect 1 — "validation gate" vs "human approval gate" — is meaning drift, and no string method reaches it

**Source:** `docs/specs/2026-08-18-cross-reference-checker.md:59-74`, which classifies it out of
scope and owes this entry (spec implementation step 8). Original observation: the 5a gate,
2026-08-18.

`CLAUDE.md` `## Plan discipline` calls a phase boundary a **validation gate**; the plan's phase
prose reads in places as a **human approval gate**. Nine different phrasings across the two
documents say versions of the same thing with different force. An agent that reads the wrong one
either stops for permission it does not need, or advances past a boundary that wanted a human.

It is filed here rather than built because **it defeats every method the checker has**. String
matching cannot compare nine phrasings. Key comparison needs a key, and there is none — the two
documents never name the same field. Generation cannot help either: neither side is derived from
the other, so there is no single source to regenerate from. Any check written for it would pass
whatever it was written against, which is the unbindable-checkbox failure the 5a recovery was
for — `MVP_PLAN_V3.md:2213` was read by no test at all and still sat checked.

Reopens when either document is rewritten such that one side becomes generated from the other, or
when a third occurrence of the drift causes real wrong work. Until then the mitigation is the one
already applied: the human answered it as trigger 6 at `34d9fc5`, and `CLAUDE.md` now states the
answer once, in one place.

### The product half — a decision graph inside LenGentic — is out of scope, and revival is trigger 2

**Source:** human decision 2026-08-18, at the first question of the decision-graph design loop.
Recorded in `docs/specs/2026-08-18-cross-reference-checker.md:15-23`.

The original request had two halves. The dev-harness half became the cross-reference checker
spec. The product half — a decision graph _inside_ the product, recording and linking the
decisions LenGentic itself observes — was cut.

The reason it was cut is that it is not new work: LenGentic already **is** a decision-observation
system. §18 aggregates by group key, §19 gates, §20.1 collects counterexamples, §21 renders.
Those sections are approved and unbuilt. Building a second decision-recording mechanism beside
them, while the first one is still being implemented, is redesigning the approved MVP during
implementation — forbidden by `CLAUDE.md` `## Plan discipline`.

**Anyone reviving this reaches the human first.** It materially changes approved product scope,
which is escalation trigger 2. It is not a packet a coordinator may dispatch on its own judgement,
and the fact that it is written down here is not approval to build it.

Reopens only after §18–§21 are built and shipped, and only if the shipped thing demonstrably
fails to record something a user needed — which is evidence this entry does not have today.

### `STALE` needs a read-model vocabulary, and it lands in `platform/shared/read/**` — not `schema/`

**Source:** Reviewer finding SC1 against `p2.shared-schema` at `195af11`,
`.artifacts/evidence/2/wire-contract-review-195af11.md`. **Trigger:** `p2.runs-api`, Phase 2 wave 3.

`platform/shared/schema/status.ts:4` freezes `RUN_STATUSES = ['RUNNING','COMPLETED','FAILED']`.
ADR 0005 decision 4 requires the API response to report `STALE`, computed server-side from
`lastEventAt` and the existing `STALE_RUN_THRESHOLD_MS`. The stored enum cannot express it, and
`MVP_PLAN_V3.md:592` is explicit that `STALE` is derived at read time and **never stored**.

**Already decided — Architect's option B, previous session.** `p2.runs-api` widens its
`allowed_paths` into `platform/shared/read/**` and puts the response vocabulary there. Deliberately
**not** `schema/`, so `CLAUDE.md` `## Types` — "`platform/shared/schema/**` is the only wire
contract" — stays literally true: `schema/` is the _ingestion_ contract, `read/` is the _response_
model, and neither one leaks into the other.

It is filed here because the decision existed only in a previous session's context. Reviewer could
not tell "a later wave adds it" from "nobody noticed", and said so as its own unknown. That is the
whole failure mode: an unwritten decision is indistinguishable from an oversight, and comes back as
a finding every time someone reads the code fresh.

**What `p2.runs-api` must not do:** declare a second run-status enum anywhere under
`platform/shared/schema/**`, or mutate `RUN_STATUSES`. Either one makes the stored enum and the
response enum the same object, and the next writer stores `STALE`.

Closes when `p2.runs-api` ships the read model with a test that asserts a run whose `lastEventAt`
is older than `STALE_RUN_THRESHOLD_MS` reports `STALE` while its stored `status` is still
`RUNNING` — both halves asserted, because either alone passes on a wrong implementation.

### `entityId === runId` consistency check for run events — dropped at S4, re-add only with a citation

**Source:** Recovery of `p2.shared-schema` at `c39f4d2`,
`.artifacts/evidence/2/wire-contract-recovery.md:169`. **Trigger:** `p2.ingest-endpoint`, or any
future §12 amendment.

`parse.ts` used to reject a run event whose `entityId !== runId`. The rule appears nowhere in
§12/§13, so S4's remedy was "cite or drop" and it was dropped — the wire contract currently does
not enforce it. It is a defensible inference; per ADR 0006's own reasoning, re-adding it later
narrows what the wire accepts, so if it comes back it needs a plan citation (or an ADR) and its
own rejection code — not `INVALID_PAYLOAD`, which §12 reserves for Zod payload failures.

### Self-parent (`parentStepId === entityId`) cycle detection — dropped at S4; already a read-time candidate

**Source:** Recovery of `p2.shared-schema` at `c39f4d2`,
`.artifacts/evidence/2/wire-contract-recovery.md:171`; same idea as the architect brief's own
backlog item (`.artifacts/plans/2-wave1-architect-brief.md:764-771`, "`parentStepId` cycle
detection at read time"). **Trigger:** `p2.runs-api` (read-time), or a §13 amendment (wire-time).

`parse.ts` used to reject a `step.started` whose `parentStepId === entityId`. No §12/§13 citation
exists, so it was dropped from the wire contract. The architect brief already flags cycle
detection as a read-time concern — one detector at read time covers self-parent as the trivial
case and true cycles as the general one, which ingestion-time checking never could. Do not
re-add it at the wire without a plan citation.

### `REQUEST_ERROR_CODES` is half a contract — the endpoint must confirm the names and land the response shape

**Source:** Reviewer finding SC-A on `c39f4d2` (per-node contract review, 2026-08-18).
**Trigger:** `p2.ingest-endpoint`.

`platform/shared/schema/ingest.ts:43-47` exports three request-level code names
(`BODY_TOO_LARGE`, `INVALID_JSON`, `INVALID_BATCH`). `MVP_PLAN_V3.md:530-533` names those
rejections in prose only — the strings are invented, and nothing binds them to a response:
`IngestResponseSchema` has no request-level error arm, so `p2.ingest-endpoint` still invents
the HTTP-400 body shape. On the record: the same commit dropped two rules for lacking a
citation (S4) while adding these three uncited names — both moves were directed by review, so
this is a naming decision the endpoint packet must **confirm, not inherit**. Closes when the
endpoint lands the 400-body schema in `platform/shared/schema/**` (it is wire contract) using
these names or replacing them in the same commit, with a test binding code to body.
