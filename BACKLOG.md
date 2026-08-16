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
