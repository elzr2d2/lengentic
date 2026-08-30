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

**Active and unresolved entries only, as of 2026-08-19.** The "stays where it is" rule
above is amended: an addressed or superseded entry moves — verbatim, **Source:** and
**Trigger:** lines intact — to `docs/archive/BACKLOG_HISTORY.md` at wave gates, so
retrieval ranks open work first. Nothing is deleted; the two files together are the full
ledger.

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

- ~~**Per-lane `DATABASE_URL`.**~~ **Resolved 2026-08-19**, at the trigger (`p2.prisma-run-step`
  dispatch). R9 compares file paths, so two lane worktrees sharing one Postgres was an
  undeclared shared write surface `check-lane-ownership.mjs` cannot see. `pnpm lanes
worktrees <id...>` now also prints a command that copies the root `.env` into the lane
  worktree with `DATABASE_URL`'s `schema` param rewritten to `lane_<slug>` — same Postgres
  instance, isolated schema per lane; Prisma creates the schema on first `db:migrate`. Fix:
  `scripts/lanes.ts` (`readBaseDatabaseUrl`, `laneSchemaName`, `laneDatabaseUrl`), covered by
  the existing `pnpm check:lanes` suite (38/38 green, unchanged count — no new scenario added,
  this is a printed-command change, not new gate logic).
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

### Merge state is rehydrated across requests, and `completionFieldOrigins` must survive the round trip

**Source:** Architect ruling on the `p2.merge-rules` completion-field repair, 2026-08-18 (lane
`lane/p2.merge-rules`, HEAD `3d0696d`). **Trigger:** `p2.ingest-endpoint` only — narrowed
2026-08-19, storage half closed by `p2.prisma-run-step` at `ce2b8f5`/`42cbe55` (see below).

Order-independent completion-field merging needs per-key provenance — which (`occurredAt`,
`eventId`) last wrote each key — carried in `EntityMergeState` as `completionFieldOrigins`. Inside
one `mergeEvent` fold chain that is free. Across requests it is not: if the ingest endpoint loads
state from Postgres, merges, and writes back **without** persisting the origins map, every key's
origin resets on the next batch and the last-arriving batch wins per key again — the exact ADR 0007
§3 violation the repair removes, reintroduced one layer up and invisible to `merge-rules.spec.ts`,
which never crosses a process boundary.

**Closure condition (a), storage half, is met.** `p2.prisma-run-step` added
`completionFieldOrigins Json?` to `Run` and `Step` (migration
`20260819080115_run_step_completion_origins`, commit `ce2b8f5`), doc-corrected at `42cbe55` after
a Reviewer pass caught the comment misdescribing the key structure (fresh eyes: it would have
reintroduced this exact bug one layer down if followed literally — see the new entry below).
Column name, shape (`Json?`, mirrors `metadata Json?`) and doc comment now match
`EntityMergeState.completionFieldOrigins` at `merge-rules.ts:56-60,76`.

**Still open — the only remaining condition:** the test half of (a) — a test that merges two
completion events carrying disjoint keys in two separate requests, in both arrival orders, and
asserts one final state — plus the actual read/write wiring at the ingest endpoint. That is
`p2.ingest-endpoint`'s packet, not this one. Ruled out already: storing provenance inside
`completionFields` itself, which leaks merge bookkeeping into the value the persistence edge maps
(`CLAUDE.md` `## Types`).

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

### `merge-rules.ts` per-key provenance drops 12 `Object.prototype` key names, silently

**Source:** Fresh Tester re-verification of the `p2.merge-rules` order-independence repair,
commit `f9443a4`, 2026-08-18 (agent `aa6430a1ab6589c69`). **Trigger:** whichever packet gives a
caller control over `metadata` key names flattened into `fields` — likely `p2.ingest-endpoint`.

`nextOrigins`/`nextFields` in `mergeEvent`'s completion branch are plain `{}` objects. A key
named `toString`, `constructor`, `hasOwnProperty`, `valueOf`, `__proto__` (12 total —
`Object.prototype`'s own names) reads back the **inherited** prototype member instead of
`undefined` when probed with `nextOrigins[key]`, so the provenance guard falls through to
`compareCompletionOrder(incoming, <prototype member>)`, computes `NaN`, and `NaN > 0` is
`false` — the key is silently dropped: no value written, no origin recorded, no error. The
start branch (whole-record replace) is unaffected — same input keeps all 12 keys there.
Regression introduced by the per-key-provenance repair itself: the prior shallow-spread
implementation (`{...base.completionFields, ...completionEvent.fields}`) preserved these keys,
since object spread uses `CreateDataProperty` and never consults the prototype chain.

**Not reachable today.** Completion payload top-level keys are the closed set `{status,
metadata}` (`platform/shared/schema/run-events.ts:17-20`, `step-events.ts:18-20`); a
caller-controlled key name only reaches `fields` if some future packet flattens `metadata`'s
contents into the top level before folding. No prototype pollution occurs — `{}.polluted`
stays `undefined` in the tester's probe.

Closes when whichever packet makes `fields` keys caller-controlled either fixes
`nextOrigins`/`nextFields` to `Object.create(null)` (or gates lookups with
`Object.hasOwn`) in the same commit, or the wire contract stays closed-set forever and this
entry is closed as "never reachable" with that citation.

### `merge-rules.ts` completion tiebreak resolves by eventId, not by time, on sub-millisecond ties

**Source:** Same Tester pass as above, commit `f9443a4`. **Trigger:** any packet touching
completion timestamp precision — likely `p2.ingest-endpoint` or a future `TimestampSchema`
tightening. Pre-existing behavior, not introduced by this repair.

`TimestampSchema = z.iso.datetime({ offset: true })` (`platform/shared/schema/primitives.ts:8`)
accepts sub-millisecond precision (e.g. `.000100Z` vs `.000900Z`), but `compareCompletionOrder`
compares via `Date.parse`, which truncates to whole milliseconds. Two schema-valid completions
900µs apart truncate to an equal instant and fall to the eventId tiebreak — the genuinely
**earlier** event can win if its `eventId` sorts greater. `MVP_PLAN_V3.md:505-506` says "last
writer wins by `occurredAt`"; ADR 0007 scopes the eventId tiebreak to an "identical"
`occurredAt`, which sub-ms-truncated-to-equal is not. Deterministic (both arrival orders agree,
so ADR 0007's order-independence purity claim is not violated) — this is a §12 semantics gap,
not an ADR 0007 violation. Closes when `TimestampSchema` is tightened to reject sub-millisecond
precision, or the comparator is changed to compare full ISO strings before falling back to
`Date.parse`, with a test at exactly this boundary.

## Discovered designing p2.prisma-run-step's schema (2026-08-19)

### ADR 0005's dedup table has no lane that can write it

**Source:** Architect packet `p2.prisma-run-step`, design step, 2026-08-19. Full design at
`.artifacts/lanes/p2.prisma-run-step-design.md` in lane worktree
`lengentic-lane-p2-prisma-run-step` (not committed — Architect writes no lane code; copy it
out before the worktree is ever removed if the design itself needs to survive).

`p2.prisma-run-step` is the only Phase 2 node whose `allowed_paths` include
`platform/database/prisma/**` (`scripts/oracle/graph.json`), and its packet text says
"Implement only Run and Step" — so it correctly does not add an idempotency/dedup table.
But `p2.idempotency`'s `allowed_paths` are `platform/api/src/**` only (graph.json:567-569) —
no later node can write a migration for the dedup table ADR 0005 assumes exists. **Trigger:**
whichever packet is framed to implement idempotent upsert (work package #3 in Phase 2's
table) — either widen that node's `allowed_paths` to include `platform/database/prisma/**`,
or split a small schema-only sub-node it depends on. Decide before that packet is dispatched,
not while it is running.

**RESOLVED 2026-08-20** — first option taken, by human decision under trigger 3.
`p2.idempotency`'s `own.allowed` now includes `platform/database/prisma/**` and
`platform/database/src/**`, `risk` is `high`, and a `model IngestedEvent` probe blocks the
node until the ledger exists. This item predicted the failure correctly but was reached from
the other end: the gap surfaced first as defect F3 on `p2.ingest-endpoint`, whose Tester
ruled `BLOCKED` naming `schema.prisma` rather than widening its own boundary. Ruling
`.artifacts/evidence/2/f3-ruling.md`; contract correction `docs/decisions/0009`, which
supersedes `0008` §A-7.

### `Run`/`Step` have one `metadata` column but two independently-resolved merge bags

**Source:** Reviewer finding S-C on `p2.prisma-run-step` lane commit `ce2b8f5`, 2026-08-19.
**Trigger:** `p2.ingest-endpoint`.

`EntityMergeState` keeps `startFields` (first-writer-wins by `occurredAt`) and `completionFields`
(last-writer-wins by `occurredAt`) as two independently-resolved bags (`merge-rules.ts:62,65`), and
for both `Run` and `Step` today the sole key of each bag is `metadata`. But `schema.prisma` has one
`metadata Json?` column per model — nowhere to store both the start-winner and the completion-winner
independently. Not `p2.prisma-run-step`'s to fix: `MVP_PLAN_V3.md` §13 lists exactly one `metadata`
field per model, so the schema matches its contract as written; adding a second column is a domain-
model change outside this packet's authority. Already an open question in the packet's own design
note (`.artifacts/lanes/p2.prisma-run-step-design.md:324`, gitignored, not on `main`) — recorded here
so it survives the worktree. Closes when the ingest-endpoint packet either adds the second column (a
domain-model change, likely needs an ADR) or shows one column is sufficient and records why.

### No mechanical check that migration SQL reproduces `schema.prisma`

**Source:** Reviewer finding S-D on `p2.prisma-run-step` lane commit `ce2b8f5`, 2026-08-19.
**Trigger:** `p2.idempotency`, or whichever packet next needs a migration and has write access to
root config.

`platform/database/prisma.config.ts` sets no `datasource.shadowDatabaseUrl`, so
`prisma migrate diff --from-migrations ./prisma/migrations --to-schema ./prisma/schema.prisma
--exit-code` errors out instead of running: `Error: You must set datasource.shadowDatabaseUrl in
your prisma.config.ts if you want to diff a migrations directory.` `pnpm gates` runs `prisma
generate` off `schema.prisma` directly and never reads `prisma/migrations/`, so a hand-edited,
truncated, or missing migration file would pass every gate green. Today the two happen to agree —
verified by manual column-for-column read-back across two migrations — but this is the first
migration-bearing Phase 2 packet and every later one inherits the same blind spot. Not
`p2.prisma-run-step`'s to fix: `prisma.config.ts` is outside its `allowed_paths`
(`platform/database/prisma/**`, `platform/database/src/**`), and wiring a gate step touches root
scripts. Collides with the still-open "ADR 0005 dedup table has no lane that can write it" entry
above — same root cause, no node currently has write access to both `prisma.config.ts` and a gate
script. Closes when a shadow database URL is configured (locally or in CI) and a migration-drift
check is added to `pnpm gates` or `pnpm gates:full`.

### `pnpm db:migrate -- --name <x>` hangs; `pnpm exec prisma migrate dev --name <x>` works

**Source:** Two independent Builder runs on `p2.prisma-run-step`, 2026-08-19 (both the original
schema commit and the `completionFieldOrigins` repair). **Trigger:** whichever packet next
touches the root `package.json` migration script, or a standalone fix whenever it starts
costing real time.

`pnpm db:migrate -- --name <migration-name>` hung both times it was tried on this packet;
`pnpm exec prisma migrate dev --name <migration-name>` (bypassing the package script) worked
immediately both times, same effect. Root cause not diagnosed — not blocking, since the
workaround is one substitution — but will bite every future migration-bearing packet the same
way until someone looks at how `db:migrate` forwards its args.

## Discovered during the .claude infrastructure audit (2026-08-19)

The audit report with `file:line` citations is `.artifacts/audits/2026-08-19-claude-infra-audit.md`.
Items 1–6 of its §7 ranked fix list were implemented on branch `harness-audit-fixes`
(commits `e52bb2e`–`77f42a1` plus the fixes-1/2/5 commit); everything below was deliberately
deferred. None of it is required by the Phase 2 Definition of Done.

### Verify that claimed artifact paths exist

**Source:** audit §7 item 7 (§3 item 8). **Trigger:** the next packet that touches
`scripts/lanes.ts` evidence checks, or a standalone harness fix.

`artifact` paths in evidence entries and the top-level `artifacts` array are never checked to
exist — "the output is at this path" is an unchecked claim, and `report-handoff` builds its
detail-in-artifact discipline on it. `checkEvidence` already has the handoff in hand; an
`existsSync` per cited path closes it. Deferred because it needs a decision about worktree-relative
vs repo-relative paths for lanes running in worktrees.

### In-repo, model-invocable charter skill for autopilot §0

**Source:** audit §7 item 9 (§4 item 2). **Trigger:** the next attempt to start autopilot
unattended, or on a fresh clone.

`autopilot` step 0 requires `grill-with-docs`, which is user-global and sets
`disable-model-invocation: true`, so autopilot cannot start unattended and a fresh clone has no
charter step at all. Move a minimal charter-capture skill into `.claude/skills/`.

### `frame-phase` stops unconditionally; should stop only on trigger 3

**Source:** audit §7 item 10 (§4 item 1, §5 item 9); `frame-phase:81-82`. **Trigger:** the next
phase framing (Phase 3 start).

The skill says "stop and confirm with the user" per phase, contradicting CLAUDE.md's "a phase
boundary is a validation gate, not an approval gate". Make it stop only when the decision
frontier is non-empty (escalation trigger 3), and wire it to `pnpm decide`, which no skill
currently calls.

### `pnpm oracle green <phase>` aggregating GREEN's four sources

**Source:** audit §7 item 11 (§3 item 9). **Trigger:** the next phase validation gate.

Three of GREEN's four sources are prose only (`autopilot:98-104`); gates alone are executable.
The oracle already has `path`/`absent` probe kinds — a command that aggregates gates, probes,
handoff verdicts and open findings into one GREEN/RED would make `validate-phase` mechanical.

### Structured finding metadata in `handoff.schema.json`

**Source:** audit §7 item 12 (§3 items 10, 11). **Trigger:** the next change to
`.claude/rules/handoff.schema.json`.

Reviewer's `this-node` tags and count, watchdog's per-hit confirmed/unconfirmed marker and
reflector's seven mandatory fields exist only in prose; `classification` is free text while a
4-value enum already exists at `log-event.schema.json:74-77`. Add `classification`, `nodeId`
and a finding-owner tag so the wave gate can read them mechanically.

### Script-written autopilot checkpoint and machine-readable mode flag

**Source:** audit §7 item 13 (§4 items 3, 4). **Trigger:** the next autopilot run.

Nothing writes `.claude/autopilot.local.md` but model discipline, and it is the sole authority
for recovery-attempt history. "Under autopilot" has no machine signal (`validate-phase:48`
branches on a mode no script can read). `pnpm autopilot checkpoint` plus a flag file closes both.

### Doc rot: retired-plan citations and contradictions

**Source:** audit §7 item 14 and the whole §6 list. **Trigger:** standalone mechanical sweep,
or whichever packet next edits each file.

**Partially closed 2026-08-20** by the harness-throughput pass: `update-backlog` (v2/§94
citations and the BACKLOG.md structure description), `run-quality-gates` (v2 §29/§31),
`dispatch-lanes` gates:full cadence, `review-diff` dispatch default, `validator.md`
"every executable work packet", and `format-changed.mjs` (deleted outright — pre-commit
formats staged files now). Still open from the §6 list: `validate-phase:45-46` mis-cite,
`report-handoff` per-role table, `validate-handoff.mjs` brace-regex, the three DONE
definitions, ADR 0004 vs `agent-activation.json`, and the activationConditions asymmetry.

The full §6 list, verbatim targets: `update-backlog:8,18,34` cites v2 and §94 (v3 is §27);
`run-quality-gates:8,29` cites v2 §29/§31; `update-backlog:28-33` misdescribes BACKLOG.md's
structure; `validate-phase:45-46` mis-cites where GREEN's four sources are defined;
`report-handoff`'s per-role table omits validator while `validator.md:52` points at it;
`dispatch-lanes:114-116` says gates:full once per batch but `.husky/pre-commit` runs it per
commit; `review-diff:3` says per-commit review while `agent-activation.json` and
`CONTEXT.md:131` say per-wave; `agent-activation.json:82` cites `pnpm lanes selftest` (alias is
`check:lanes`); the "disjoint by construction" comment is false and already logged at
`BACKLOG.md:1067-1104`; `format-changed.mjs:40` exempts `MVP_PLAN.md` but not `MVP_PLAN_V3.md`;
`validate-handoff.mjs` brace-regex is non-greedy and can truncate nested objects outside a
fence; three definitions of DONE (lane schema, phase GREEN, `log.finish()`) with only the first
machine-enforced; ADR 0004 vs `agent-activation.json` disagree by design with the machine output
known-wrong (`docs/decisions/0004:95`) — an `agentOverride` per node would encode it; diagnose/
architecture/retrospective have `activationConditions` but are never optional, while `review` is
optional in two classes with no condition.

### Agents cannot run their own mandated procedures

**Source:** audit §7 item 15 (§4 item 6). **Trigger:** the next edit to any `.claude/agents/*.md`.

Reviewer must dispatch two sub-agents (`review-diff:34-36`) with no Task tool; diagnostician is
told to reach for runner with no Task tool; no agent lists `Skill`; builder declares no `tools:`
at all and silently inherits everything. Decide per role and declare explicitly.

### Validator and reflector are unreachable through capability resolution

**Source:** audit §7 item 16 (§4 item 5); `oracle.ts` capability resolution takes the first
existing agent file. **Trigger:** the next change to `agent-activation.json` capabilities.

`execute` resolves to runner, `adversarial-test` to tester; `retrospective` appears in no class.
`validator.md:6` claims it "fires after every executable work packet" and is in fact dispatched
by hand. Either wire them into classes or record dormant-by-design in the file itself.

### Lane handoff return path that survives the gitignored `.artifacts/`

**Source:** audit §7 item 17 (§6); `.gitignore:15`, `dispatch-lanes:96`,
`autopilot.local.md:11-13` (already burned once). **Trigger:** the next parallel lane dispatch
that uses worktrees.

A lane worktree's handoff JSON never propagates to the main repo because `.artifacts/` is
gitignored. Add a copy step to `pnpm lanes integrate`, or a tracked handoff directory.

### Small autonomy mechanics: worktree cleanup rule, backlog linter, usage summary shape

**Source:** audit §7 item 18 (§5 items 5, 6). **Trigger:** opportunistic, next time each surface
is edited.

Three small items: (a) worktree cleanup decided by evidence (handoff DONE + branch merged +
clean `git status`) instead of a standing human question; (b) a linter that every BACKLOG entry
carries `**Source:**` and a trigger; (c) `token_or_usage_summary` as a structured object so
Reflector can aggregate it without parsing prose.

## Discovered during the harness-throughput pass (2026-08-20)

### ADR-0002's too-conservative Detection clause has fired — human review owed

**Source:** `pnpm decide detect` against live lane telemetry, first surfaced when the
harness-throughput pass made `pnpm check:decide` green (the ADR parse errors had been
masking it). **Trigger:** before the next time `lanePolicy` or the R1–R15 requirement set
is edited, or at the next phase gate, whichever is first.

R1 (at least two units) and R12 (benefit exceeds overhead) each blocked 2 batches that later
integrated without incident (`p5.negative-fixtures`, `p1.debt.secrets`). That is exactly the
signal ADR-0002's Detection section says would show the sequential default is too
conservative. Counterevidence before acting: both were single-unit batches, and "blocked
then succeeded sequentially" may be the system working, not over-blocking — the detect
heuristic cannot tell those apart. A human should read the ADR against the telemetry and
either loosen nothing, tune the REPEATEDLY threshold, or record the verdict in the ADR.

### Orphaned-Step events are silently re-attached instead of surfaced

**Source:** the original p2.ingest-endpoint Tester attack (2026-08-19, deferred by Builder as
out of the recovery's scope). **Trigger:** the packet that next touches
`platform/api/src/telemetry/**` merge behavior, or Phase 2's wave gate review.

A Step event whose `runId` matches no Run is silently attached anyway. `MVP_PLAN_V3.md` §12
says orphans must be surfaced, not silently mis-attributed — the current behavior files
telemetry under a run that may never exist, which poisons aggregation quietly. Fix wants a
deliberate orphan policy (store-and-flag, or per-event result naming the orphan state),
never a widened merge.

## Provided as Engineering Standards §13 — Future Backlog (2026-08-20)

Five future capabilities handed to the session as a standards section. The boundary rules
that go with them (FUT-1..FUT-5) are in `docs/ENGINEERING_STANDARDS.md` ## Future backlog
boundary, which points back here for the ideas. All five are **out of scope now**;
none may be prepared for with speculative abstractions. The section's own §13.6 entry format
and §13.7 Watchdog boundary are process rules, not backlog items — they already match this
file's entry shape and the `update-backlog` skill, and are not duplicated as entries.

Every one of these is an "instrument first, learn later" item, so each trigger below names a
run count. The counts are first-pass numbers chosen here, not given by the source section;
move them deliberately rather than letting them drift.

### Architecture Intelligence View (agent architecture heatmap)

**Source:** Engineering Standards §13.1, provided 2026-08-20 (Architect + Product/UI).
**Trigger:** after Phase 5b ships and >= 30 real runs with per-step telemetry are in the
store — earlier, every cell of the heatmap would be one sample.

Overlay the module/dependency graph with agent execution telemetry and engineering
violations: fan-out, circularity, co-change, token/context cost per module, repair-loop
frequency, failed gates, mutation survivors, failure hotspots. Goal is to find modules that
are expensive or unsafe for an agent to change. Deferred because the graph exists
(`dependency-cruiser`, `scripts/oracle/graph.json`) but the run telemetry to overlay does
not yet. Already ruled out: reading high token usage alone as bad architecture, and
presenting any correlation here as causation.

### Agentic Maintainability Score

**Source:** Engineering Standards §13.2, provided 2026-08-20 (Reflector + Analysis Engine).
**Trigger:** not before the §13.1 view exposes raw per-module evidence, and not before

> = 50 runs spanning at least two model/workflow versions.

A repository/module-level signal for how hard it is for an agent to change something safely.
Candidate inputs: Context Surface Ratio (files/modules read divided by files/modules
changed), repair iterations, repeated context reconstruction, gate failure rate, regression
rate, tokens and time per successful change. Deferred because a composite score invented
before the data is an arbitrary static formula that then looks authoritative. Already ruled
out: shipping the score before the raw evidence, and any formula that cannot separate task
complexity from architecture complexity or account for model/workflow version differences.

### Delayed decision outcome attribution

**Source:** Engineering Standards §13.3, provided 2026-08-20 (Decision Intelligence +
Reflector). **Trigger:** once `docs/decisions/` holds >= 10 ADRs whose affected scope is
machine-readable and >= 20 runs post-date the oldest of them.

Connect an engineering/architecture decision to outcomes observed in later runs — e.g. an
adapter boundary followed by lower context per task and fewer repair loops, or a shared
mutable store followed by more race failures and retries. Makes strategic decisions
measurable over time instead of only recorded. Any future record must retain decision ID,
timestamp/version, affected scope, rationale, expected outcome, observed metrics,
confidence/limitations, and known confounders. Already ruled out: claiming causal impact
from a simple before/after comparison. This is the engineering-side twin of the product's
counterfactual problem — LenGentic does not observe counterfactuals here either.

### Learned / adaptive engineering policies

**Source:** Engineering Standards §13.4, provided 2026-08-20 (Decision Intelligence +
Reflector). **Trigger:** only after attribution (§13.3) exists, and only for a policy class
with >= 20 observations of the same class.

Use accumulated run evidence to recommend different thresholds or validation policies —
complexity threshold, mutation-testing scope, gate selection, context-reset threshold,
fan-out warning, model-specific validation. Both directions are in scope: recommend stronger
hardening for a class where mutation testing keeps finding real gaps, and recommend
re-examining a costly gate with near-zero unique findings that other evidence already
catches. Already ruled out: autonomously weakening security guarantees, correctness
contracts, data-integrity invariants, or architecture boundaries — every learned policy
change goes through the existing approval and escalation rules. Related and live today:
ADR-0002's Detection clause, whose first firing is the open entry above.

### Context lifecycle optimization (CONTINUE / COMPACT / HANDOFF / RESET / SPAWN_FRESH)

**Source:** Engineering Standards §13.5, provided 2026-08-20 (Orchestrator + Reflector).
**Trigger:** after the dumbzone detector has emitted >= 40 decision points with the outcome
of each recorded, so a learned rule can be scored against the current heuristic.

Learn when an agent should continue, compact, hand off, reset, or spawn fresh, from context
size, task transition, repeated reads, repeated failed edits, repair-loop count,
contradictory decisions, tokens since the last successful checkpoint, and context
reconstruction cost. Goal is to minimize context degradation and needless fresh-agent
startup at the same time. The dumbzone detector and the `session-handoff` skill are today's
hand-written heuristic and are enough for now. Already ruled out: shipping a new heuristic
and calling it learned behavior without the runs to back it.

## Discovered upgrading the engineering standards layer (2026-08-20)

### Mutation testing (Stryker) — evaluated, not installed

**Source:** the standards upgrade, 2026-08-20. Evaluated against the tree rather than
adopted from the prompt that named it. **Trigger:** when `platform/analysis-engine` has

> = 40 tests, or when a false green survives a phase gate and the manual mutation check
> would have caught it. Either one, whichever comes first.

`TEST-6` — a test that cannot fail is not a test — is real and currently held by the manual
mutation check in the `test-at-seams` skill plus `pnpm check:integrity`'s
`false-green-assertion` BLOCK rule. Stryker would make it a measured score instead of a
practice. Deferred on cost, not on doubt: a full Stryker run re-executes the suite once per
surviving mutant, which at this suite size costs more wall-clock than the phase gate it
would sit inside, and the surface where a false green is fatal — the analyzers — is small
enough to check by hand today. Already ruled out: setting a mutation-score threshold before
a tool measures one, and running mutation testing on every change rather than risk-based.

### Cyclomatic complexity is unbounded in `scripts/**`

**Source:** measured during the standards upgrade — `complexity` at 10 reports 38 functions
across the harness, the worst two at 61 (`scripts/lanes.ts:955`, `:1338`), against 4 in
`platform/**` with a maximum of 14. **Trigger:** the next packet that substantially edits
`scripts/lanes.ts`, or a diagnosis whose root cause is a branch inside one of those two
functions.

`DESIGN-3` binds `platform/**` and `playground/**` at 15 and deliberately exempts the
harness, because a limit that fails the build on landing is a limit nobody keeps. The
functions are dispatch and gate logic — wide switches over well-typed unions, which is the
shape complexity metrics punish most and read worst. Splitting them is its own work with
its own regression risk and wants a reproduction, not a metric. Already ruled out: setting
the harness limit at 61 so it passes, which measures nothing.

### No unit test pins the API's client-safe error message

**Source:** verifying the `[MUST]` rows in `docs/ENGINEERING_STANDARDS.md` had real
enforcers — `ERR-4` (no stack trace, secret, or internal identifier in a response body) had
none that `pnpm test` runs. **Trigger:** the next packet touching
`platform/api/src/common/**`, or Phase 2's wave gate.

`clientSafeMessage` in `all-exceptions.filter.ts` is exercised only by
`test/health.integration.spec.ts`, which needs Docker and is not part of `pnpm test`. The
rule is therefore unenforced in the gate that actually runs on every commit. A unit test
over the filter's mapping — including the internal-error path, which is the one that leaks
— closes it and costs almost nothing. Already ruled out: moving the integration test into
`pnpm test`, which would make the default suite need a Docker daemon.

### `noUnusedLocals` is off, so dead exports are invisible

**Source:** the same enforcer sweep. **Trigger:** bundle it with the next `tsconfig.base.json`
change; not worth a packet of its own.

`@typescript-eslint/no-unused-vars` catches unused locals inside a module, but nothing
detects an exported symbol that no longer has a consumer — the hardening lane's
"is anything unreachable?" question has no tool behind it. `noUnusedLocals` /
`noUnusedParameters` are the cheap half; the export half needs `knip` or equivalent, which
is a dependency decision, not a config flag. Already ruled out: adding the dependency in a
standards pass, where it would arrive with no measured violation behind it.

## Discovered in the p2.ingest-endpoint human-directed repair (2026-08-20)

### `EVENT_LEVEL_ERROR_CODES` cannot detect the drift its own comment forbids

**Source:** the attempt-2 Tester driving the contract directly —
`.artifacts/evidence/2/tester-reverify-attempt-2/raw/wire-contract.txt`, and
`docs/decisions/0010` Consequences. **Trigger:** the next packet that owns
`platform/shared/schema/**`, or any review that finds a second undeclared code on the wire.

`platform/shared/schema/ingest.ts:30-36` says of `EVENT_LEVEL_ERROR_CODES`: "Derived from
`INGEST_ERROR_CODES` itself, so this list cannot drift from the codes it classifies." The
derivation is real, but `IngestEventResult.code` is `z.string()`, so a code in neither list
parses fine and reaches the wire unnoticed. Not hypothetical: a Builder invented
`PROCESSING_FAILED`, shipped it through the wire contract, and passed `pnpm gates` with it —
no mechanical check in the repo could see it. The Tester found it only by importing the
schema and asking.

The fix is to narrow `code` from `z.string()` to the union the constants already define, so
an undeclared code fails to parse. Deferred because it is a wire-contract change on a surface
`p2.ingest-endpoint` does not own, raised mid-repair on a lane already under repair for a
false green — precisely the shape `docs/decisions/0009` refused to widen for. Already ruled
out: admitting `PROCESSING_FAILED` to the list to make the drift legal (rejected by the human
by name, `docs/decisions/0010`), and leaving the comment standing while it is untrue.

Closes when `code` is a closed union and a test asserts an undeclared code fails
`IngestResponseSchema.parse`.

### Survive an unhandled rejection from the driver: the API process must not exit on a killed connection

**Source:** F-4 of the `p2.ingest-endpoint` human-directed repair Tester report,
`.artifacts/evidence/2/tester-human-repair/README.md:188` (raw:
`raw/killconn-C.txt`, `raw/api-crash-killA/B/C.log`). Deferred by human decision 2026-08-20
under `CLAUDE.md` trigger 3. **Trigger:** the packet that owns API bootstrap/lifecycle
(`platform/api/src/main.ts` and the Nest bootstrap surface), or any hardening pass on
process resilience.

Hold the advisory lock for an entity externally, POST for that entity so the request blocks
inside its interactive transaction, wait past Prisma's 5000 ms transaction timeout, then
`pg_terminate_backend` the API's blocked backend. The request returns `500` with
`resultsField=ABSENT` — and then the whole API process exits. Reproduction 3/3 whenever the
kill lands after 5000 ms. The rejection is `Error: Connection terminated unexpectedly`,
raised by Prisma's transaction-timeout timer attempting a `ROLLBACK` on the dead connection
(`@prisma/client@7.9.1` → `@prisma/adapter-pg@7.9.1` → `pg@8.23.0`); it is never attached to
the request promise chain, so Node exits on it.

Two things are wrong and only the first is ours. **(a)** No process-level
`unhandledRejection` guard exists, so any library rejection outside a request chain is fatal.
**(b)** The 500 should arguably be a 503 — but that is moot while the process is dead.

Deferred because the crash originates inside `@prisma/client`'s own timer and not in
`platform/api/src/telemetry/**`, which is the only surface `p2.ingest-endpoint` owns. Fixing
it there would mean widening the lane to API bootstrap on a packet that has already failed
twice, and the guard belongs to the process, not to one endpoint.

Note `docs/decisions/0010`'s four-case table is written as exhaustive over _responses_, and
this is a fifth condition that produces no response at all. That record was not amended: the
human ruled the case out of its frame rather than into it. Whoever closes this should decide
whether ADR 0010 gains a row or a neighbour record is written.

Closes when a `pg_terminate_backend` during an in-flight transaction leaves the API process
alive and serving, proven by a live-Postgres test that re-runs `raw/killconn2.mjs`'s recipe
and then asserts `GET /health` still answers.

---

## Discovered integrating p2.ingest-endpoint and p2.idempotency (2026-08-20)

### Move the structural-depth cap into `INGEST_LIMITS` with the other wire limits

**Source:** Coordinator review of `p2.ingest-endpoint` repair attempt 3 (`08874c9` on
`lane/p2.ingest-endpoint`, 2026-08-20). Raised by the Builder itself in its handoff
`follow_up_required`, and confirmed as correct placement by the Coordinator.
**Trigger:** the next packet that owns `platform/shared/schema/**` — the same trigger as the
`EVENT_LEVEL_ERROR_CODES` entry, and ideally the same commit.

The F-1/F-3/F-6 class fix introduced `MAX_STRUCTURAL_DEPTH = 64` and
`exceedsMaxStructuralDepth` in `platform/api/src/telemetry/wire-sanitize.ts`. An event whose
`payload` nests deeper is now an event-level `REJECTED` carrying `INVALID_PAYLOAD`. That is a
**wire-visible rejection threshold**, so by `CLAUDE.md` `## Types` — "`platform/shared/schema/**`
holds Zod schemas and is the **only** wire contract" — the constant belongs in
`INGEST_LIMITS` (`platform/shared/schema/limits.ts`), beside `maxEventPayloadBytes`, which
`docs/decisions/0006` put there for exactly this reason. Today an SDK author cannot discover
the limit without reading the API's source.

It was implemented in the API because `platform/shared/schema/**` is outside
`p2.ingest-endpoint`'s `allowed_paths`, and widening a lane that had already failed twice was
the worse trade. The behaviour is correct where it sits; only the constant's _home_ is wrong.

Already ruled out: **changing the value.** 64 stands — Coordinator decision 2026-08-20. No
plan section or ADR sets a depth, the value is reversible in one constant, and no legitimate
telemetry metadata nests 64 levels. The lowest observed overflow downstream was ~1500
(`structuredClone` inside `mergeEvent`) and the highest ~9000–10000
(`containsUnsafeUnicode`), both unstable across processes, so 64 is a deliberate wide margin
rather than a tuned threshold. Do not re-litigate the number while relocating it.

Note the move is a real behaviour risk to check, not a copy-paste: the API bounds
`event.payload` as a whole, not the `metadata` key alone. Preserve that, or state the
narrowing.

Closes when `MAX_STRUCTURAL_DEPTH` is exported from `INGEST_LIMITS`, `wire-sanitize.ts`
imports it rather than declaring it, and a test asserts the rejection still fires at the same
depth through the real HTTP boundary.

---

### `pnpm gates` lints before it builds `@lengentic/database`, so any Prisma schema change fails the first run

**Source:** Coordinator post-integration verification of `p2.idempotency`, 2026-08-20, on
`main` at the merge of `lane/p2.idempotency`.
**Trigger:** the next packet that owns `package.json` gate scripts, or Phase 7's `p7.ci-full`
— whichever comes first. Not urgent; it is a false red, never a false green.

`pnpm gates` is `lint && format:check && typecheck && test && build && check:boundaries &&
check:integrity`. `@lengentic/database`'s Prisma client and `dist/` are **gitignored build
output**, regenerated by that package's `build`/`typecheck` step — which runs _after_ `lint`.

So immediately after a schema change lands, `eslint` type-aware rules resolve `PrismaClient`
against a stale `dist/index.d.ts` that does not yet know the new model, and report the new
model access as `any`. Captured verbatim at
`.artifacts/evidence/2/p2.idempotency/gates-postmerge-main.txt`:

```text
C:\CODE\lengentic\platform\api\src\telemetry\telemetry.repository.ts
  217:9   error  Unsafe assignment of an error typed value       @typescript-eslint/no-unsafe-assignment
  221:40  error  Unsafe member access .eventId on an `any` value @typescript-eslint/no-unsafe-member-access
✖ 8 problems (8 errors, 0 warnings)
```

The code was correct — `type EntityClient = Pick<PrismaClient, 'run' | 'step' |
'ingestedEvent'>` at `telemetry.repository.ts:20`. `pnpm --filter @lengentic/database build`
then `pnpm gates` → **exit 0**, 366 tests
(`.artifacts/evidence/2/p2.idempotency/gates-postmerge-main-after-dbbuild.txt`).

Note `prisma generate` alone is **not** sufficient — it rewrites `src/generated/prisma`, but
the API imports the package's built `dist`, so the package's own `build` must run. That was
attempt 1 here and it stayed red
(`gates-postmerge-main-rerun.txt`), which is the part worth remembering.

**Why this is not cosmetic.** It made a Builder's honest `pnpm gates` exit 0 unreproducible
on `main`: the lane worktree had run `db:migrate` (which regenerates and rebuilds), so its
green was real _there_ and not portable. A future Builder hitting these 8 errors will read
them as a defect in its own code and start editing working source.

**Fix options, not yet decided:** make `build` (or a `db:generate && db:build` prestep) run
before `lint` in the `gates` chain; or give `@lengentic/database` a `prepare`/`postinstall`
build; or have `lint` depend on the package build in the task graph. Whichever is chosen must
keep `pnpm gates` working with the engineering harness deleted (`CLAUDE.md ## Commands`).

---

## Discovered in the p2.run-liveness repair (2026-08-21)

### Lane schema isolation is a no-op: `?schema=` is dropped, so every parallel lane writes to `public`

**Source:** `p2.run-liveness` Builder, 2026-08-21, hitting
`relation "public.IngestedEvent" does not exist` (P2021 / SQLSTATE 42P01) inside a worktree
whose `.env` said `?schema=lane_p2_run_liveness`. Confirmed by the Coordinator at
`platform/database/src/index.ts:23`.
**Trigger:** **before the next wave that dispatches two or more lanes touching Postgres.**
This is not a "someday" entry — it is a precondition for parallel dispatch, and Phases 4, 5b
and 6 all have DB-touching lanes that `pnpm lanes decide` will happily run in parallel.

`pnpm lanes worktrees <id...>` prints, for every lane:

```text
# R9 — isolated Postgres schema so this lane and any sibling lane never share
# a write surface on the same database instance:
… DATABASE_URL=postgresql://…/lengentic?schema=lane_<id>
```

The `schema` query parameter has **no runtime effect** under Prisma 7 + `@prisma/adapter-pg`.
`node-postgres` does not understand it, and the adapter is constructed without one:

```ts
// platform/database/src/index.ts:23
const adapter = new PrismaPg({ connectionString: config.connectionString });
```

`PrismaPg` takes the schema as a **second argument** (`new PrismaPg({ connectionString },
{ schema })`), not from the URL. So the generated client keeps resolving to `public`, and
every lane that believes it has a private schema is reading and writing the _shared_ one.

**Why this is worse than a broken feature.** `pnpm lanes decide` passes R9 ("no conflicting
migration, lockfile, global config or other shared write surface") partly on the strength of
this isolation. The mechanism that makes R9 true is inert, so R9's PASS is currently an
unverified claim for any batch with two DB lanes — a green that lies about _dispatch safety_
rather than about code. Two parallel lanes running `db:migrate` or an integration suite would
truncate each other's tables and each would read the interference as a flaky test.

Nothing has actually collided yet: every parallel wave so far has had at most one lane
touching Postgres. That is luck, not design.

**Workaround used, deliberately not committed:** the Builder sidestepped it with a throwaway
_database_ (`lane_p2_run_liveness_db`) rather than a schema, and touched no committed file.

**Shape decided 2026-08-21 — (b), a per-lane database.** Two candidates were on the table:
(a) thread `schema` through `createDatabaseClient` into `PrismaPg`'s second argument and keep
parsing it out of `DATABASE_URL`, so the printed instructions become true; or (b) drop the
schema pretence from `scripts/lanes.ts` and print a per-lane **database** instead, which is
what actually isolates under this adapter.

Decided by the Coordinator at the Phase 2 wave 2 gate rather than escalated, because a
preference is inferable from project rules — `CLAUDE.md` `## Plan discipline`: "Prefer the
simplest solution satisfying the current Definition of Done", and prefer the reversible option
under uncertainty. Three reasons, in order of weight:

1. **(b) is the only shape with a demonstrated working instance in this repository.** The
   `p2.run-liveness` Builder isolated itself with a throwaway database and it worked, on this
   Prisma version, against this adapter, on this machine. (a) rests on a reading of `PrismaPg`'s
   constructor signature and has never been run here.
2. **The failure mode that produced this entry was silent**, and (b) cannot be silently
   re-broken by an adapter upgrade: a missing database errors loudly, a dropped `schema`
   parameter does not.
3. **(b) is less code**, and it deletes a comment that currently claims something false rather
   than adding machinery to make the false claim true.

**What (a) buys that is now given up, stated so it is not re-litigated as an oversight:** one
Postgres database for the whole repo, and instructions matching the comments already written.
Reopen only on evidence that per-lane databases are too expensive to create — which is a
measurement nobody has taken, not a prediction.

**Still required, and not weakened by the decision:** a test that _fails_ when isolation
regresses. The entire cost of this entry is that nothing asserted the isolation worked, and
choosing the loud-failure shape reduces that risk without removing it. Migrations must run per
lane database in worktree setup — fold this into the same packet as the standing
`pnpm -r --filter '!@lengentic/dashboard' run build` fix, since both are "the worktree arrives
unusable" and both belong in one setup step.

Closes when two lanes can concurrently run the API integration suite against the same
Postgres instance without seeing each other's rows, proven by a test that goes red if the
isolation is removed.

## Discovered building the dashboard test harness (2026-08-21, Phase 2 wave 2)

### The dashboard hand-declares `HealthReport`, a twin of the API's health contract

**Source:** Noticed while adding `@lengentic/shared` to `platform/dashboard` at `eb5587f`, the
pre-dispatch plumbing for `p2.dashboard-runs`. **Trigger:** the next change to `/health`'s
response shape, or Phase 6 when the dashboard grows a second API surface — whichever is first.

`platform/dashboard/src/lib/api.ts:30-36` declares `CheckStatus` and `HealthReport` by hand.
The API's real contract for `/health` lives in `platform/api/src/health/**`. Nothing links the
two, so `checks: { database: 'up' | 'down' }` changing on the API side goes unnoticed on the
dashboard side until a status page renders `undefined` — and a status page that lies is worse
than no status page, which is the exact reasoning already written into that file's own comments.

This is the same defect class that `df9ee84` removed for the runs contract: a response shape
declared twice because the consumer could not import the producer. The fix has the same shape
too — the health contract moves to `platform/shared/read/`, reachable through
`@lengentic/shared/read`, and the dashboard imports it. That path and its subpath export now
exist, so the fix is a move plus two import lines, not new architecture.

**Not fixed at `eb5587f` on purpose.** No lane in Phase 2 wave 2 owns `/health`:
`p2.dashboard-runs` has `platform/dashboard/src/**` and its deliverable is the runs explorer.
Folding an unrelated contract move into a plumbing commit is the phase expansion `CLAUDE.md`
forbids, and it would put an unreviewed change under a lane's feet mid-wave.

Closes when `HealthReport` has exactly one declaration in the repository, with a test that
fails if the API's health response and the dashboard's type disagree — not merely a shared
type, because a shared type both sides import is still unverified against the actual JSON.

## Discovered at the Phase 2 wave 2 gate (2026-08-21)

### The Run detail page's JSX is unproven — placement never reaches a rendered assertion

**Source:** `p2.dashboard-runs` carried this forward in `.artifacts/backlog/dashboard-runs-pending.md`;
the wave 2 gate's S2 fix made it sharper rather than closing it. **Trigger:** the next change to
`platform/dashboard/src/app/runs/[id]/page.tsx`, or Phase 6 when scenario runs must be shown to
render their anomalies — whichever is first.

`buildStepTree`, `countPlacement` and now `describeStepAnomalies` are all pure, all mutation-checked,
all proven in the node environment. What no test touches is the JSX between them and a reader:
whether `placement: 'orphaned'` actually produces the visible "orphaned · parent X not in this run"
markup, whether `PlacementMark` is reached at all, whether the header renders the string
`describeStepAnomalies` returns. The S2 fix deliberately pulled the header sentence OUT of the
component so it could be proven without a DOM — which closes the sentence and leaves the wiring
exactly as unproven as before.

The blocker is unchanged: a component test needs `// @vitest-environment jsdom` and jsdom is not an
installed devDependency, so it is a `platform/dashboard/package.json` write. No Phase 2 lane owns
that file.

Closes when a test renders the Run detail page with a tree containing a root, a nested step, an
orphan and a cycle, and asserts all four are visible and labelled — and fails when a `case` is
removed from `PlacementMark`.

### Neither `Run.metadata` nor `Step.metadata` reaches the screen

**Source:** `p2.dashboard-runs`, carried forward. **Trigger:** Phase 4, when metadata stops being
an empty object in practice — §13's payload-safety work is what starts putting real content there.

Both fields are in the read contract and neither page renders them. Not a defect today: nothing
writes anything worth showing. It becomes one the moment a caller uses metadata to carry the
context a human needs to interpret a run, and finds the Dashboard silently dropping it.

Closes when both are rendered, or when a decision records that metadata is deliberately not a
Dashboard surface and says where a caller is expected to read it instead.

## Discovered at the Phase 2 wave 3 gate (2026-08-21)

### `check:integrity`'s `arbitrary-sleep` rule only matches a literal digit, so a computed sleep passes

**Source:** the wave 3 gate on `p2.stale-on-kill`. **Trigger:** the next time a BLOCK-severity
rule in `scripts/check-integrity.ts` is edited, or the first `check:integrity` finding that a
human disputes — whichever is first.

`scripts/check-integrity.ts:81` tests `\bsleep\s*\(\s*\d`. `kill-mid-run.integration.spec.ts`
shipped three waits; the scanner flagged the helper definition and the poll interval, and did
**not** flag `await sleep(STALE_TEST_MS + 300)` — the one wait that was a genuine TEST-1
violation, because the argument starts with an identifier rather than a digit. The two hits it
did report were the pacing of loops that already terminated on an observable condition.

So the rule is inverted in practice on both sides: it blocks the benign shape and passes the
harmful one. That is the "green that lies" class `CLAUDE.md` names, sitting inside the checker
whose whole job is catching it. A `sleep(TIMEOUT)`, `sleep(ms)`, `delay(WAIT_MS)` or
`await new Promise(r => setTimeout(r, DURATION))` anywhere in the repo is currently invisible.

Deliberately not fixed at this gate: widening the regex is a change to a mechanical gate that
will surface hits across every existing test file at once, and no Phase 2 node owns that blast
radius. It is a packet, not a drive-by.

Closes when the rule distinguishes a _duration wait_ (blocking, whatever the argument
expression) from a _poll interval inside a condition-terminated loop_ (allowed), and
`scripts/check-integrity.spec.ts` — or whatever proves the rules — pins both directions with a
fixture that fails when either half is removed.

## Discovered building the Playground scaffold (2026-08-21, Phase 3 wave 1)

### Every cross-package workspace import is invisible to `pnpm check:boundaries`

**Source:** `p3.scaffold`, proved in `.artifacts/evidence/3/scaffold-boundary-proof.md`.
**Trigger:** before the Phase 3 gate, or the first time a boundary rule between two workspace
packages is relied on as the only evidence for a Definition-of-Done line — whichever is first.

`playground/index.ts` imports `@lengentic/telemetry-sdk`. dependency-cruiser's JSON reporter
reports `playground/index.ts -> []`: the specifier resolves through the package `exports` map
to `platform/telemetry-sdk/dist/index.js`, and `.dependency-cruiser.cjs` excludes `dist` from
the graph, so the edge is dropped before any rule sees it. The same is true of
`platform/api -> @lengentic/shared` and of every other `workspace:*` edge in the repository —
the cruise reports 317 dependencies and not one of them crosses a package.

What the config does still catch is a **relative deep import**
(`../platform/telemetry-sdk/src/transport`), which is the shape a violation would realistically
take from inside `playground/**`, and the proof above shows it discriminating: deep import
`exit=1`, the same path shape at `src/index` `exit=0`. So the rules are not decorative. But
`playground-not-to-api`, `playground-not-to-other-platform-packages` and
`sdk-depends-on-shared-only` are today enforced against only one of the two import shapes, and
a bare `import { PrismaClient } from '@lengentic/database'` inside `playground/` would cruise
clean.

Deliberately not fixed here: the repair is either resolving `exports` to source instead of
`dist` (an `enhancedResolveOptions` change felt by every package) or narrowing the `dist`
exclusion (which pulls generated JS into the graph and slows every cruise). Both are changes to
a shared mechanical gate whose blast radius is the whole tree, and no Phase 3 node owns that.
`p3.scaffold` owns three files under `playground/`.

Closes when a bare-specifier import from `playground/` into a forbidden platform package fails
`pnpm check:boundaries`, pinned by a fixture that goes green again when the rule is removed.

## Discovered in the first live supervised run (2026-08-21)

### ~~`flow next` skips an UNRECORDED gate when any later phase already has landed work~~ — FIXED 2026-08-21

**Source:** the first `pnpm autopilot` run against the live derived state, immediately after
`docs/decisions/0013`. Captured in `.artifacts/evidence/autopilot/live-dogfood.md`.
**Trigger:** BLOCKING — before the next supervised run, and before Phase 2 is claimed complete.
This is not a deferred improvement; it is a hole in the progression invariant and it is filed
here only because closing it changes approved control-plane behaviour that has its own passing
scenario (`pnpm check:flow` #8).

Phase 2 stood at 11/11 with **neither** the wave-3 gate nor the phase gate recorded. The
supervisor's reconcile worker cleared the stale `step: recovering`, and the very next
`pnpm flow next` returned `ADVANCE_PHASE 2 -> 3`. It did not return `WAVE_GATE`. It did not
return `PHASE_GATE`. Two gates that had never run were stepped over, and the supervisor —
correctly, because it never dispatches by judgement — advanced.

The mechanism is `scripts/flow.ts` `transition()`:

```
const outstanding = nodes(s).filter((n) => n.state !== 'DONE');
const phaseGated  = records.some((r) => r.gate === 'phase' && r.segment === s.id);
if (outstanding.length > 0 || (!phaseGated && !laterWorkStarted(i))) { current = s; break; }
```

`laterWorkStarted(i)` is true when ANY node in ANY later segment is not `TODO`. Under the
amended execution order `0 -> 1 -> 5a -> 2 -> 3 -> 4 -> 5b -> 6 -> 7`, phases 4, 5 and 7 already
carry landed nodes (`oracle status`: 1/6, 4/8, 1/5). So for segment 2 the guard is permanently
true, segment 2 is treated as "historically closed", and its ungated state can never be
selected again.

The comment above it states the intent: "A finished segment with later work already landed is
historically closed; re-gating it would reopen a completed phase." That intent is right for a
segment that WAS gated. It is wrong for one that never was, and the code does not distinguish
the two — `phaseGated` is computed and then discarded whenever `laterWorkStarted` is true.

Why this is not a drive-by fix: `pnpm check:flow` scenario 8 ("a completed segment with later
work already landed is historically closed") asserts today's behaviour deliberately. Changing
it is a change to approved control-plane semantics, and two project rules genuinely conflict —
never reopen a completed phase, versus never step over an unrecorded gate. That is `CLAUDE.md`
trigger 6, and it is the human's call, not a repair.

The shape of the fix, for whoever takes the packet: `laterWorkStarted` should suppress
re-selection only for a segment that carries a **recorded phase gate**. An ungated segment with
outstanding gate records stays selectable however much later work has landed — the amended
execution order guarantees later phases will have landed work, so under v3 this guard as
written disables the phase gate for every segment except the last.

Note what did NOT save this. `scripts/autopilot/progression.ts` refuses to record a gate whose
sources disagree — but it is only reached when a gate action is returned. A gate that is never
asked for is never held. The invariant sits one layer above the hole.

**Resolved in the Coordinator session of 2026-08-21.** Evidence:
`.artifacts/evidence/harness/flow-segment-selection-gate-skip.md`. `pnpm check:flow` scenarios 13
and 14, written red first, mutation-probed; 14/14.

**The trigger-6 call above does not hold, and that is why this was fixed rather than asked.**
The claimed conflict is "never reopen a completed phase" versus "never step over an unrecorded
gate". The first is not a project rule — it is a comment in `flow.ts` stating an implementation
intent. `CLAUDE.md` does carry a rule about what completion means: GREEN is four sources that
must agree, and a gate record is the pointer to that proof. A segment whose gate never ran was
therefore never _completed_, so choosing "never step over an unrecorded gate" invalidates
nothing. The entry's own next sentence concedes the point: "That intent is right for a segment
that WAS gated. It is wrong for one that never was."

Scenario 8 was kept, not overruled. The discriminator is membership of the record regime — a
segment holding **zero** gate records predates `pnpm flow record` and stays closed by history
(phases 0, 1 and 5a); a segment holding any record owes the rest. Scenario 8's fixture has no
records, so it passes unchanged, and the fix is one commit to revert.

### `p4.*` and `p7.*` probe DONE while Phase 3 is entirely TODO

**Source:** third candidate in the segment-selection diagnosis above; not addressed by that fix.

Under the amended order `0 -> 1 -> 5a -> 2 -> 3 -> 4 -> 5b -> 6 -> 7`, `pnpm oracle status`
reports Phase 4 at 1/6 and Phase 7 at 1/5 with Phase 3 at 1/7. Those landed states are what made
`laterWorkStarted` true for segment 2 in the first place. `pnpm check:probes` already WARNs on
all five Phase 7 nodes.

If those probes are satisfiable by another node's deliverable, this is the oracle-must-not-lie
hazard that already ate both wave-3 analyzer packets
(`.artifacts/evidence/5a/oracle-lint-proof.md`), the segment-selection bug was downstream of it,
and the same false DONE states will mislead somewhere else. If they are genuinely done work that
landed early, the states are honest and only the WARN needs retiring.

**Trigger:** before the Phase 4 gate, or the next time `check:probes` WARNs are triaged —
whichever comes first. Not before the Phase 2 and Phase 3 gates, which do not depend on it.

## Discovered at the Phase 2 wave 3 gate, Validator pass (2026-08-21)

### `kill-mid-run` proves "eventually STALE" but not the comparison's direction, so two sibling tests are the only net

**Source:** Validator NM1 at the `p2.stale-on-kill` wave gate,
`.artifacts/evidence/2/wave3-gate-validator/README.md` and `NM1-inverted-comparison.log`.
Independently re-run by the Coordinator before the record was written.

Invert the comparison in `platform/api/src/runs/stale.ts:40` — `idleMs > staleThresholdMs`
becomes `idleMs < staleThresholdMs` — leaving the `storedStatus !== 'RUNNING'` guard untouched.
`platform/api/test/stale-on-kill/kill-mid-run.integration.spec.ts` **survives it, 3/3 runs, both
tests green**. A fresh RUNNING run's `idleMs` starts near zero, so the mutated derivation reports
STALE on the first poll and the positive test's "eventually STALE" wait passes vacuously; the
negative test never notices because the guard is what it exercises.

**This is not a defect in the node, and the wave gate is GREEN on it.** The node's contract is
the path — a real spawned process, a real `SIGKILL`, STALE read back over live HTTP — and that
path is what it proves. Boundary and arithmetic exactness is `stale.spec.ts`'s job, the file
says so in its own comment, and the division holds: under the same mutation `stale.spec.ts`
fails 5 of 8 assertions (Coordinator re-run: `pnpm --filter @lengentic/api test stale.spec`,
`Tests 5 failed | 3 passed (8)`, sha1 `9ff0ee0c…` restored, `git status` clean).

So the whole suite catches an inverted comparison; only this file does not. The exposure is
that the net is exactly two tests wide — `stale.spec.ts` and
`run-lifecycle.integration.spec.ts:594` — and neither is obviously load-bearing when read from
`kill-mid-run.integration.spec.ts`. A future refactor that deletes or weakens either one removes
the only thing catching an inverted-comparison regression at this seam, and the integration test
that looks like it covers STALE will stay green.

**Cheapest fix, if taken:** the positive test asserts the run is NOT STALE before the kill, then
STALE after. One extra assertion, and NM1 stops surviving.

**Trigger:** any change to `stale.ts`, `stale.spec.ts` or the stale threshold wiring — or the
Phase 5 analyzer work, which is the next thing that reads run liveness. Not before the Phase 2
phase gate; it blocks nothing there.

**Validator's own declared unknowns, carried forward rather than treated as verified:** NM1 was
not re-executed against `run-lifecycle.integration.spec.ts:594` directly (that catch is reasoned
from reading, not run), and no mutation was attempted against `stale-threshold.provider.ts` or
`runs.service.ts`'s single-clock-read invariant.

## Discovered at the Phase 2 phase gate, repair 1 (2026-08-23)

### `DATABASE_URL`'s `?schema=` is honoured by the Prisma CLI and ignored by the runtime client

**Source:** Phase 2 phase gate, handed to the repair lane as an unfiled item and explicitly
placed out of the repair's scope. Directly adjacent to the existing entry "Lane schema
isolation is a no-op: `?schema=` is dropped, so every parallel lane writes to `public`"
(`BACKLOG.md`, "Discovered in the p2.run-liveness repair (2026-08-21)") — read that one first;
this is the half it states as a consequence rather than as the defect.

One environment variable, two consumers, two different answers:

- `prisma migrate deploy` / `prisma migrate dev` parse `?schema=` out of `DATABASE_URL` and
  create and migrate **that** schema.
- The runtime client does not. `platform/database/src/index.ts:23` builds
  `new PrismaPg({ connectionString })`; `node-postgres` has no `schema` connection parameter,
  and `PrismaPg` takes the schema as a separate second argument. The client resolves to
  `public` whatever the URL says.

So a `DATABASE_URL` carrying `?schema=X` migrates `X` and then reads and writes `public` — the
tables exist, in the wrong place, and the first symptom is `relation "public.IngestedEvent"
does not exist` (P2021 / 42P01) rather than anything naming the schema. Every checked-in URL
in the tree carries `?schema=public` (`.env.example:12`, `.github/workflows/ci.yml:15`,
`docker-compose.yml:37`, `docker/api.Dockerfile:44`, `README.md:79`), which is why nothing has
diverged in practice: the parameter agrees with the value it is being ignored in favour of.

**Deferred because** it is not a Phase 2 DoD line and the repair lane's scope boundary named it
out. **Worth doing when** anything sets `?schema=` to something other than `public` — parallel
lane isolation (the entry above, already trigger-tagged "before the next wave that dispatches
two or more lanes touching Postgres"), a multi-tenant deployment, or a per-suite integration
schema. **Already ruled out:** removing `?schema=` from the URLs to make the two agree by
subtraction — the CLI needs it, and dropping it would silently move migrations rather than fix
the divergence. The fix is to pass the schema to `PrismaPg` as its second argument, parsed from
the same URL, so the two consumers read one value.

### The SDK's counters lose events at shutdown-timeout: `recorded=10 delivered=0 droppedUndeliverable=0`

**Source:** Phase 2 phase-gate Tester, "Running the script with the API down does not crash the
script, harsher than the test" (`.artifacts/evidence/2/phase-gate/tester/README.md:85-102`,
raw at `raw/hung-api-stdout.txt`). Recorded there as "observation only, not a defect". Handed
to the repair lane as an unfiled item and placed out of its scope.

The Tester re-ran the API-down case against a **black-hole** port — TCP accepted, never
answered — instead of the closed port `platform/telemetry-sdk/test/process-exit.spec.ts:81`
uses. That is a different code path (`requestTimeoutMs` / `AbortSignal`, not ECONNREFUSED).
The host behaved correctly: `HOST_EXIT=0`, 6s elapsed, 0 bytes of stderr, no hang, no crash.

The counters did not:

    HOST-OK ... recorded=10 delivered=0 undeliverable=0

At shutdown-timeout the ten events are accounted for in `queued` alone. A consumer reading only
`delivered` and `droppedUndeliverable` — the two counters that read as "what happened to my
events" — sees ten events vanish with no bucket claiming them. Contrast the reachable-but-
erroring case (503 on every attempt), where the same host reports
`recorded=10 delivered=0 undeliverable=10` and the arithmetic closes.

**Deferred because** no Phase 2 DoD line covers SDK counter completeness, and the shipped
behaviour under test — "does not crash the script" — is met. **Worth doing when** anything
starts _asserting_ on these counters as an accounting identity: the natural invariant is
`recorded == delivered + droppedUndeliverable + queued`, and Phase 6's mock scenarios plus any
future SDK observability surface would want it to hold at shutdown as well as in flight. Note
that `stale-on-kill/fixtures/abandoned-run.ts:51` already gates on `stats().delivered`, so the
counters are load-bearing in at least one test today. **Not yet decided:** whether the fix is a
`droppedOnShutdown` bucket of its own or folding the timed-out batch into
`droppedUndeliverable` — they say different things to a reader and the choice is a small
contract decision, not an implementation detail.

---

## Discovered at the Phase 2 phase gate, repair 2 (2026-08-23)

### `fetchRunDetail` reads every non-2xx as "no such run", so an API outage renders Next's not-found page

**Source:** Phase 2 phase-gate Tester, attempt 2, finding SR-1
(`.artifacts/evidence/2/phase-gate-2/tester/README.md` §8, raw at `raw/SR1-404-oracle.txt`).
Confirmed by mutation, not by reading. Handed to repair 2 and explicitly placed out of its
scope — repair 2 owns the two blocking green-that-lies findings and nothing else.

`platform/dashboard/src/lib/runs-api.ts:81-86` distinguishes 404 from every other non-2xx: a
404 becomes `{ kind: 'not-found' }`, which `runs/[id]/page.tsx:23` turns into `notFound()`, and
anything else becomes an HTTP-error failure card. Collapsing that — treating every non-2xx as
`not-found` — leaves the dashboard suite at **31/31 EXIT=0**, because the only assertion on the
branch is `rejects.toThrow()` at `runs-pages.spec.ts:366-374`, and `notFound()` and any other
throw are the same event to it. There is no detail-page non-2xx test at all.

Consequence if it ever regresses: a 503 from a degraded API renders "this run does not exist"
— ERR-3's four error classes collapsed at the boundary, and the reader sent to look for a
missing run instead of a sick service. Severity is low today (the code is correct; only the
alarm is missing) and it is independent of the two findings repair 2 closed.

**Worth doing when** anything else touches `runs-api.ts`'s failure classification, or at the
next hardening pass over the Dashboard. **The fix is a test, not a change:** a detail-page case
stubbing 503 that asserts the failure card and `HTTP 503` (the list page already has exactly
this test), plus tightening `rejects.toThrow()` to name what `notFound()` actually throws so
the 404 case and the outage case cannot satisfy one another. **Already ruled out:** asserting
only that the two branches differ — that passes on any two distinct throws and is the same
shape of oracle that let this through.

---

## Discovered at the Phase 2 phase gate, round 3 — scoped Reviewer over `2ebf0d8..ecb54df` (2026-08-24)

### Create the `killAndWait` spawn-failure entry that two repairs both reported as already filed

**Source:** Phase 2 phase-gate Reviewer, round 3, finding S1
(`.artifacts/evidence/2/phase-gate-3/reviewer/review-diff.md`). Owner `p2.stale-on-kill`.
Non-blocking.

**This entry exists because the finding did not.** `.artifacts/evidence/2/phase-gate-2/repair-2/README.md:128`
asserts "Reviewer S-2, Sc-2, Sc-4 — BACKLOG, untouched." For S-2 that was false:

    $ grep -n "killAndWait\|liveHosts\|S-2\|spawn-failure" BACKLOG.md
    (exit 1)
    $ grep -n "killAndWait\|liveHosts\|S-2" .artifacts/backlog/pending.md
    (exit 1)

The finding was carried in prose across two repairs and never written down, while being cited
twice as filed. `review-diff` §5 names this exact failure mode. Recording that here because the
process defect is the more expensive half: a finding believed filed is never re-derived.

**The technical substance, now at two sites.** `platform/api/test/nested-steps/nested-steps.integration.spec.ts:384-398`
inlines the logic of `killAndWait` (`platform/api/test/stale-on-kill/kill-mid-run.integration.spec.ts:164-172`)
without naming it:

```ts
if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
return new Promise<void>((resolve) => {
  child.once('close', () => resolve());
  child.kill('SIGKILL');
});
```

On a spawn failure the child emits `error` then `close` while `exitCode` and `signalCode` both
stay `null`. A reaper running after that `close` attaches a `once('close')` listener to a process
that will never emit again, and the hook hangs to `hookTimeout: 180_000`.

**Deferred because** it is reachable only if `spawn(process.execPath, ...)` itself fails, and no
Phase 2 DoD line covers fixture-host teardown. It was never reproduced — the reasoning is from
Node's `error`/`close` semantics, read against both files. **Worth doing when** the next test file
spawns a fixture host, or anything changes `killAndWait`. **Prefer** extracting one shared helper
over a third copy; the maintainability half of the finding is that the second copy carries no
reference back to the first, so a fix at the named site silently misses it. **Already ruled out:**
fixing only `kill-mid-run.integration.spec.ts` — that is what leaves the second site behind.

**Trigger:** the next test file that spawns a fixture host, or any change to `killAndWait`.

### `summaryCard()` couples to the summary card being first — file the trigger, do not loosen the oracle

**Source:** Phase 2 phase-gate Reviewer, round 3, finding S3, reviewing a coupling the Builder
flagged itself. Owner `p4.run-explorer` / `p4.run-summary`. Non-blocking.

`platform/dashboard/src/app/runs/runs-pages.spec.ts`'s `summaryCard()` selects the **first**
`<section class="card">` on `/runs/[id]`. Inserting a card above `RunSummaryCard` fails loudly.

**The trade is correct as made and the Reviewer would not change it.** The alternative — a
`data-testid` or stable class — means editing `runs/[id]/page.tsx` to suit a test, in a commit
that correctly declared itself coverage-only and touched no product markup. The coupling also
diagnoses itself rather than merely failing: mutation D2c's real output was
`expected { title: '4 steps', rows: [] } to strictly equal { title: 'checkout-agent', …(1) }` —
the intruding card names itself by its own title in the first field of the diff.

**The residual risk is not the failure, it is the repair.** The natural response to that red is
to loosen the oracle rather than add a hook, and a looser selector — any card containing a "Run
id" row — reintroduces the exact defect this repair closed: an unscoped claim about the whole
document. That is what this entry exists to say.

**Worth doing when** a node adds a card above `RunSummaryCard`: add a stable hook to the page at
that moment, and keep the oracle scoped. **Already ruled out:** widening the selector.

**Trigger:** any node adding a `<section class="card">` above `RunSummaryCard` on `/runs/[id]` —
`p4.run-explorer` and `p4.run-summary` are the named candidates.

### The SDK counter entry's own stated condition is now met at a second site

**Source:** Phase 2 phase-gate Reviewer, round 3, finding S2. Owner `p2.sdk-core`. Non-blocking.
Amends "The SDK's counters lose events at shutdown-timeout" (flushed above, this same section
group).

That entry says it is worth doing "when anything starts _asserting_ on these counters as an
accounting identity" and names `stale-on-kill/fixtures/abandoned-run.ts:51` as the first such
site. `nested-steps.integration.spec.ts:426-428` is now the second — it asserts `recorded` is 10,
`delivered` is 10 and `undeliverable` is 0. The condition is met; the entry is no longer waiting
on a hypothetical.

**Not a green that lies.** The Reviewer checked the direction of the risk: at shutdown-timeout
the counters report `delivered=0`, so the new test goes **red**, not falsely green, and the
parent-chain `toStrictEqual` catches missing steps regardless. Against a live local API with
`requestTimeoutMs: 2_000` the path is not expected at all. This is a flake-surface note.

**Trigger:** unchanged from the parent entry, but now firing on two call sites rather than one.

### Two assertions in `nested-steps.integration.spec.ts` are unreachable under NEST-1, so their ability to fail is unproven

**Source:** Phase 2 phase-gate Tester, round 3, declared unknowns
(`.artifacts/evidence/2/phase-gate-3/tester/README.md`). Owner `p2.runs-api`. Non-blocking.

NEST-1 reddens `nested-steps.integration.spec.ts` at the HTTP parent-chain assertion (`:328`).
Vitest aborts the test there, so two later assertions in the same test **never execute** under
that mutation and are therefore mutation-unverified:

- the Postgres read-back at `~:344`, the spec's advertised **second interface** (response and
  stored row must agree);
- the name-to-status paired negative at `~:353`.

They are not known-broken — they are unattested. The spec's headline claim is that it checks the
chain twice, through two interfaces; only the first is proven capable of failing.

**Deferred because** the alarm the repair owed is proven, and the DoD clause ("create nested
Steps") is discharged by the assertion that does fire. **Worth doing when** anything changes the
persistence edge for Steps, or the next time this file is touched. **The mutation that would
prove it** must diverge storage from the response — mutating the read path alone cannot, since
both assertions read the same chain. **Already ruled out:** reordering so the Postgres assertion
runs first — that just moves the unproven half, it does not prove either.

**Trigger:** any change to Step persistence or to `nested-steps.integration.spec.ts`.

### `platform/telemetry-sdk/dist/` is gitignored, so `git status` cannot police a mutated build artifact

**Source:** Phase 2 phase-gate Tester, round 3, residual risk 2. Owner `p2.sdk-core`.
Non-blocking, but it is a **method** hazard for every future mutation pass.

The spawned fixture host imports the SDK by package name through its `exports` map, which
resolves to `dist/`, **not** `src/`. So a source mutation only reaches the host after a rebuild —
and `dist/` is gitignored (`.gitignore:2`). Two consequences, in opposite directions:

1. A mutation pass that forgets to rebuild gets a **false GREEN** — the RED it expected never
   appears because the host is still running the pristine artifact. The round-3 Tester guarded
   against exactly this by confirming `dist/handles.js:35` carried the mutation before trusting
   NEST-1's red.
2. A mutation pass that rebuilds but restores only `src/` leaves a **mutated artifact on disk**
   that `git status --porcelain` reports as a clean tree. The next suite to run picks it up.

The round-3 pass hash-verified the rebuilt artifact back to `e3056557a57ec0d964fea246f2cc5c7315a4f6d6`.
That was discipline, not a mechanism.

**Deferred because** no DoD line covers mutation-harness hygiene and the one pass that hit it
handled it correctly. **Worth doing when** any future mutation pass targets the SDK — the cheap
form is a documented pre/post `sha1sum` step in the mutation procedure; the stronger form is
having the harness rebuild-and-verify rather than asking the agent to remember. **Already ruled
out:** un-ignoring `dist/` — it is a build artifact and checking it in trades this hazard for a
worse one.

**Trigger:** the next mutation pass against `platform/telemetry-sdk`, or any change to how the
fixture hosts resolve the SDK.

## Discovered at the Phase 3 wave-2 gate — Reviewer over `0da0e9f..894a56e` (2026-08-24, filed at re-gate 2026-08-25)

### Compose the two seed domains when the workflow is wired

**Source:** wave-2 Reviewer S10 (`.artifacts/evidence/3/wave2-gate/reviewer/review-diff.md:291`).
Non-blocking; not a defect in either lane's code today.

The PRNG duplication in `playground/providers/prng.ts` is justified (the SDK exports no raw
PRNG, and a deep import is forbidden), and `determinism/seed.ts` correctly refuses to re-derive
`SeededClock`. What is missing is anything relating `MockProvider.seed` to
`createSeededComponents(seed)` — one scenario seed currently yields two independent determinism
domains and nothing composes them. Whoever wires the five-step workflow has to pick the seam.

**Trigger:** `p3.mock-agent`.

### One test-file convention, and `AwarenessContext` renamed to the shape `CONTEXT.md` owns

**Source:** wave-2 Reviewer S9 (`review-diff.md:285`) and V1 (`review-diff.md:322`). Both LOW,
both deferred from repair 1 on scope.

S9: `playground/strategy/evaluator.test.ts` is co-located `.test.ts`; the other two lanes use
`<dir>/test/*.spec.ts`, as does the rest of the repo. The integrator's `playground` test script
globs both, which works but freezes the split. Pick `test/*.spec.ts`, move the one file.

V1: `playground/strategy/types.ts:66` uses `AwarenessContext` for the input-only subset while
`CONTEXT.md:68` defines the term as the stored shape including `evaluation`. The divergence is
documented in the doc comment, but the word is overloaded at the exact seam where
`p3.mock-agent` must build the stored shape from the input shape. Rename to
`AwarenessContextInput` and leave `AwarenessContext` to the term `CONTEXT.md` owns.

**Trigger:** `p3.mock-agent` touching the evaluator seam, or any next edit to
`playground/strategy/**`.

### Two residual LOW notes: a stale doc claim and one lenient parse branch

**Source:** wave-2 Reviewer S8 (`review-diff.md:279`) and S11 (`review-diff.md:306`). Both LOW,
unfixed by repair 1 (`04cc5db`), neither blocking.

S8: `playground/determinism/index.ts:2-4` claims `MockProvider` imports from here; after the
R5 composition-root fix it routes through `playground/index.ts` instead. Correct the tense or
the claim when the file is next touched.

S11: `playground/strategy/evaluator.ts:223` still silently coerces a malformed `risk.reasons`
to `[]` — the parser's only lenient branch (the `Object.create` half of S11 was fixed by R2's
own-property checks). Not reachable from `JSON.parse` output; a note, not a demand.

**Trigger:** next edit to either file.

## Discovered at the Phase 3 wave-3 gate — Reviewer over `6e97944..HEAD`, p3.mock-agent (2026-08-25)

Source for all five: `.artifacts/evidence/3/wave3-gate/reviewer/review-diff.md`. Gate PASSED,
0 blocking; these are the non-blocking residue, filed with their triggers.

### Reserve the phase names against task names in `MockAgent`

S1 (MEDIUM). Task names and phase names share one namespace: a task named `plan` produces two
provider calls with identical detail, and `alwaysFailSteps:['plan']` aimed at the task fails the
Plan phase instead (run reports FAILED with `tasks: []`). Uniqueness is validated between tasks
but not against `plan`/`execute`/`validate`/`execution_strategy`.
**Trigger:** next edit to `playground/agents/**`, or `p3.cli` exposing task names to a user.

### `awarenessContext` metadata key carries the input-only shape

S2 (MEDIUM), second landing of wave-2 V1 (`BACKLOG.md`, "AwarenessContext renamed…"). The
`execution_strategy` Step's `metadata.awarenessContext` holds topology…risk but no `evaluation`,
while `CONTEXT.md:68` defines the term as including it. The type rename is `playground/strategy/**`;
the payload key lands with whoever builds the stored shape.
**Trigger:** `p3.strategy-telemetry`.

### `p3.strategy-telemetry` must remove the interim decision Step, not add beside it

Sc1 (MEDIUM). `recordStrategyDecision` is documented as deliberately-not-a-Decision, interim
until the real wire entity exists. If `p3.strategy-telemetry` adds without removing, one verdict
travels twice.
**Trigger:** `p3.strategy-telemetry`.

### Three copies of the playground test-support pair

S7 (LOW). `recording-transport.ts` + `fake-scheduler.ts` now exist in three test trees.
**Trigger:** the fourth copy, or `p3.cli` needing a fake scheduler.

### Doc and robustness residue in `mock-agent.ts`

S3 false single-run doc claim; S4 no `finally` around the telemetry lifecycle (unreachable via
MockProvider today — exemplar concern, not defect); S5 undefined-slot guard `return`s where
`continue` belongs; S6 determinism pinned only on the degenerate single-task path (Reviewer
verified parallel-mode byte-identity by hand; nothing in the suite pins it).
**Trigger:** next edit to `playground/agents/mock-agent.ts`.

## Discovered during p3.cli, filed at the Phase 3 wave-4 gate (2026-08-27)

### `TelemetryClient.flush()` can abandon a retry wait outside `shutdown()`, exiting 0 with no error

Reproduced by the `p3.cli` Builder against an unreachable API. `Client.schedule()`
(`platform/telemetry-sdk/src/client.ts`) sets `keepProcessAlive: this.draining`, true only
inside `performShutdown()`. A plain `await flush()` needing a retry backoff arms an unref'd
timer; in a short-lived script Node exits before it fires — the `flush()` promise is silently
abandoned and the process exits 0 with no output, no error, no telemetry stats. Same shape as
the already-fixed MockProvider R1 bug, one layer up. Repro: default `maxRetries` (3) against
`http://localhost:3001` with nothing listening -> `agent.run()` never resolves, exit 0, zero
stdout. Workaround in `playground/cli/happy-path.ts` today: `telemetryConfig: { maxRetries: 0 }`
(no backoff ever scheduled) — not a fix. Fix location: `platform/telemetry-sdk/src/client.ts`
(`schedule()` / `deliverBatch()`), outside every `playground/**` lane's surface.
**Trigger:** next edit to `platform/telemetry-sdk/src/**`, or any consumer calling `flush()`
without `shutdown()`.

## Discovered at the Phase 3 wave-4 gate — Reviewer over `2649e96..HEAD`, p3.cli + p3.strategy-telemetry (2026-08-27)

1 blocking (S-2, fixed at the gate: false "bounded by construction" doc claim in
`playground/workflows/execution-strategy.ts` — corrected to name `risk.reasons` as the one
unbounded caller-supplied field and the SDK's drop-not-truncate backstop). S-6 stale pointer
and Sc-D graph-surface overlap also fixed at the gate. Non-blocking residue below, filed with
triggers. Validator PASSED (653/653, Sc1 removal verified, 3 mutation kills).

### CLI telemetry line omits two drop counters and exit code ignores delivery

S-1 (MEDIUM). `playground/cli/happy-path.ts:93-104` prints 5 of 7 counters — `droppedTooLarge`
and `droppedAfterShutdown` omitted, both provably 0 today, but this wave made
`droppedTooLarge` newly plausible (large nested `rawContext`). Exit code is independent of
delivery. **Trigger:** `p4.payload-safety`, or the Phase 3 phase gate citing this command as
delivered-path evidence.

### `recordStrategyDecision` rebuilds the awareness context instead of receiving it

S-3 (LOW). `playground/agents/mock-agent.ts:436-439` vs `:354-358` — the recomputation carries
the §14 grouping key and stored provenance; nothing asserts the two contexts are equal. If
`buildDefaultAwarenessContext` ever gains a run-dependent input, `rawContext` silently stops
being the context the verdict came from. Thread the one object through.
**Trigger:** `p4.sdk-decisions`.

### `rawContext` spread is shallow — caller can mutate queued telemetry

S-4 (LOW). `execution-strategy.ts` `{ ...context }` leaves nested objects by reference; SDK
queues the envelope by reference and serializes only at the size check. A caller reusing one
`AwarenessContext` across runs can retroactively alter queued-but-unflushed telemetry. Same
class as the wave-2 seed-aliasing repair. **Trigger:** `p4.payload-safety` (safe serialize).

### `--seed=` parses to 0; space form and unknown flags silently ignored

S-5 (LOW). `happy-path.ts:59-68` — `Number('') === 0`; `--seed 42` and typo'd flags yield a
default-seed run that looks parameterised. Default-case test is a self-comparison pinning
nothing. **Trigger:** `p6.seed-repro`.

### Decision-entity DoD line must stay explicitly unchecked at the phase gate

Sc-A (MEDIUM). "The decision reaches the Platform as an `execution_strategy` Decision and is
retrievable" is unmet by design — payload rides as Step metadata until `p4.sdk-decisions`.
Hazard: a phase-gate reader sees `decisionType: 'execution_strategy'` in metadata and checks
the box. The string is there; the requirement is not. **Trigger:** Phase 3 phase gate, then
`p4.sdk-decisions`.

### No redaction anywhere on the rawContext path

Sc-B (MEDIUM). "`rawContext` is redacted and size-capped per §15" — no redaction exists;
capping is the SDK's 64 KiB whole-event drop. **Trigger:** `p4.payload-safety`.

### Delivered-path evidence for happy-path does not exist in the tree

Sc-C (MEDIUM). DoD "creates a complete Run visible in LenGentic" — every automated assertion
is on the undelivered path (`delivered=0 droppedUndeliverable=12`, exit 0). **The Phase 3
phase gate must run `pnpm playground:happy-path` against `pnpm dev` and cite delivered
counts, or record the line unverified.** **Trigger:** Phase 3 phase gate (mandatory).

### Batch-scoped path-overlap gate cannot see overlap between DONE nodes

Sc-D residue (LOW). Fixed the instance (surface narrowed back to `playground/workflows/**`),
but `pathOverlaps` in `scripts/lanes.ts:305-315` only compares units inside one dispatch
batch — two DONE nodes sharing a surface would pass R7/R8 on a repair re-dispatch.
**Trigger:** next graph surface amendment, or a repair wave re-dispatching DONE nodes.

## Discovered at the Phase 3 phase gate — Reviewer over `0da0e9f..4673baf` (reviewed 2026-08-27, flushed 2026-08-30)

0 blocking of 8. Full report: `.artifacts/evidence/3/phase-gate/reviewer/review-diff.md`.
Tester findings F1–F5 are deliberately NOT here — they are the gate's RED and are repair
work, tracked in `.artifacts/evidence/3/phase-gate/tester/README.md` and the gate record.
Standing note: wave-4 S-1 above ("CLI telemetry line omits two drop counters…") had
"the Phase 3 phase gate citing this command as delivered-path evidence" as its trigger; the
gate did cite it, so S-1 is now **due**, not deferred.

### `suite.only` invisible to the BLOCK-severity focused-test rule

S1 (MEDIUM). `scripts/check-integrity.ts:89-93` — `suite` is in `SKIP_OPTION_CALL_NAMES` but
not `FOCUS_CALL_NAMES`; `bench` the reverse. `suite()` is first-class `node:test` API and this
phase introduced `node:test`. Latent: nothing calls `suite()` today. **Do:** add `suite` to
focus set, `bench` to skip receivers, both scenarios to `scripts/check-integrity/selftest.ts`.
**Trigger:** first use of `suite()` anywhere, or next edit to `scripts/check-integrity.ts`.

### `pnpm check:integrity-self` is run by nothing

S2 (MEDIUM). `package.json:38` declares it; not in `pnpm gates`, not in CI, not in the
CLAUDE.md CI-only list. The 19 selftest scenarios are the regression guard for the exact
blind spot the wave-2 gate found; unwired, the next blind spot returns silently. **Do:** CI
step beside `check:probes`, or fold into `check:integrity`. **Trigger:** next edit to
`scripts/check-integrity.ts`, or next CI workflow change.

### CI never runs `pnpm check:integrity` at all (pre-existing)

Adjacent to S2, pre-existing, not the Phase 3 diff. `ci.yml:40-52` runs gate steps
individually and never runs `pnpm gates`, so `check:integrity` does not run in CI.
**Trigger:** next CI workflow change.

### Three shipped comments point the reader at an empty staging file

S3 (MEDIUM). `playground/agents/mock-agent.ts:24`, `playground/determinism/test/seed.spec.ts:5`,
`playground/determinism/test/telemetry.spec.ts:4` cite `.artifacts/backlog/pending.md`, which
is empty — the findings live in `BACKLOG.md` (seed-domain entry at :2391). Same defect the
wave-4 gate fixed as S-6, remaining three instances. **Do:** repoint all three at `BACKLOG.md`
plus section heading. **Trigger:** next edit to any of the three files.

### `API_PORT` assigned to a CLI that ignores it

S4 (LOW-MEDIUM). `playground/index.ts:33-34` says "reading the environment is the CLI's job";
`playground/cli/happy-path.ts` hardcodes `PLAYGROUND_DEFAULT_ENDPOINT`, no `--endpoint`, reads
nothing. With `API_PORT` ≠ 3001 the happy path posts to a dead port and exits 0. **Do:** read
`process.env.API_PORT` in `happy-path.ts`, or reword the seam comment to scope it as future
work. **Trigger:** `p4.*` work touching the CLI, or first run against a non-default port.

### cwd-derived spawn paths; `pnpm test` writes to a live dev DB

S5 (LOW). `playground/cli/test/happy-path.spec.ts:46`, `playground/providers/test/process-exit.spec.ts:24`
build spawn paths from `process.cwd()` (breaks `node --test` from root), and with `pnpm dev`
up the spawned happy-path runs persist real Runs into the dev DB as a side effect of
`pnpm test` (confirmed by tester F2: `--seed=1` run found in DB, created by the spec).
**Do:** derive from `import.meta.dirname`; consider a guaranteed-closed port for CLI specs.
**Trigger:** next edit to either spec, or first cross-package test invocation.

### `MockAgentRunResult.strategy` doc contradicts itself

S6 (LOW). `playground/agents/mock-agent.ts:109-111` — "the verdict this run actually followed
… present even when Plan failed before Execute ever started": both halves cannot hold; when
Plan fails no `execution_strategy` Step is emitted yet `strategy` is populated. Behaviour
right, sentence wrong. **Do:** "the verdict this run's Execute phase would follow; emitted as
telemetry only if Execute actually starts." **Trigger:** next edit to `mock-agent.ts`.

### Harness change rode along in the phase diff (residue = S2)

Sc1 (MEDIUM). `scripts/check-integrity.ts` (+216/−17) + selftest (+181) — no DoD line asks
for it; recorded by Reviewer as justified gate repair (the scanner could not see `node:test`
skips), not leakage. Kept here because its residue is S2 and the pattern (harness work riding
phase diffs) is worth watching. **Trigger:** next harness change inside a phase diff.

### Deny floor blocks the Write tool on the worker envelope path it mandates

Found by this gate worker (2026-08-30), harness defect. `.claude/autopilot-permissions.json`
denies `Write(./.autopilot/**)` (group 4, "a worker that can rewrite the run's own bounds"),
but the worker brief and `scripts/autopilot/worker.ts:61` mandate the outcome envelope at
`.autopilot/handoffs/<worker>.json` — the only channel for ANY outcome, including BLOCKED.
Workers fall back to allowed `Bash(node:*)` to deliver it, which also proves the deny is
cosmetic against Bash for the rest of `.autopilot/**` (state.json, leases). **Do:** carve the
envelope path out of the deny (e.g. deny `.autopilot/state.json` + `.autopilot/leases/**`
specifically), or have worker.ts accept the envelope from an undenied staging path.
**Trigger:** next edit to `.claude/autopilot-permissions.json` or `worker.ts`.

### `tsx` dependency justified only in comments

Sc2 (LOW). `playground/package.json` adds `tsx@^4.20.6`; justification (node:test needs a TS
loader, vitest is not a playground dependency) lives only in test-file doc comments.
**Do:** one line in `playground/index.ts` module doc or the package README.
**Trigger:** next `playground/package.json` edit.
