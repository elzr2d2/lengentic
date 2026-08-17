# CLAUDE.md

Project rules for LenGentic. These bind every agent and every session.

## Language

`CONTEXT.md` is the project's shared language — `attested`, `counterexample`, `contextKey`,
group key, seam, work packet, wave, green that lies. A term used loosely here becomes a
wrong column later.

Read it when you will **name** something (code, test, finding, ticket) or **judge** whether
something is correct. Skip it when you are only executing a command and reporting what
came back; the vocabulary changes nothing there.

Two neighbours, neither loaded by default. `docs/decisions/` holds a settled trade-off that
blocks nothing — read one when a shape surprises you, write one only when all three
exclusion tests in its README fail. `docs/research/` holds external facts that expire —
check `review-by` before citing, and never cite a stale note as-is.

## Retrieval

`MVP_PLAN_V3.md` is ~24k tokens and `BACKLOG.md` another ~16k. Reading either one whole to
answer one question spends most of a context window on text nobody asked for.

`pnpm kb search <words>` ranks every section of every document and returns `file:line`
citations. `pnpm kb show §19` prints that one section verbatim. `pnpm kb term contextKey`
returns the `CONTEXT.md` definition plus every place the word is really used. `pnpm kb map`
says what a full read would cost before you commit to one.

Search before Read whenever the target is prose. Read the whole file when you will edit it.
Code stays grep's job — the index is `.md` only.

Retrieval confers no authority. `MVP_PLAN.md` (v2) and `docs/superpowers/specs/**` are tagged
`[HISTORICAL]` and excluded unless `--all`; a note past its `review-by` is tagged `[STALE]`
and demoted. A tagged hit is a pointer to what someone wrote once, never a citation.

## Plan discipline

Follow `MVP_PLAN_V3.md`. It is the single executable plan.

`MVP_PLAN.md` (v2) and
`docs/superpowers/specs/2026-08-14-lengentic-mvp-corrections-design.md` are **historical**.
v3 absorbed the corrections document and retired it, so there is no longer a second document
that wins on conflict. Section numbers differ between v2 and v3 — a comment citing a section
may be citing v2.

Work on one phase at a time.

Never automatically begin the next MVP phase.

Do not redesign the approved MVP while implementing it.

Anything valuable but unnecessary for the current phase goes into `BACKLOG.md`.

Prefer the simplest solution satisfying the current Definition of Done.

Every completed phase must leave the repository runnable.

## Architecture

Platform and Playground must remain independent.

Platform must never import Playground code.

`playground/**` may import `platform/telemetry-sdk` through its public entry only. Never
`platform/api/**` or `platform/analysis-engine/**`.

`platform/telemetry-sdk` may import `platform/shared` and nothing else from the platform.
The SDK is the public artifact; a transitive Prisma dependency would make every consumer
install a database client to emit telemetry.

`.claude/` is engineering infrastructure only.

Engineering Agents must never become runtime dependencies. LenGentic must run correctly if
`.claude/` is deleted, and the Platform must run correctly if the entire Playground is
deleted.

## Types

`platform/shared/schema/**` holds Zod schemas and is the **only** wire contract. The SDK
and the API both import it; types are derived with `z.infer`.

Prisma types are database-internal and never cross a module boundary. No Prisma model is
ever returned from a controller. Map explicitly at the persistence edge.

## Verification

Mechanical checks are tooling, not agents. Never ask an agent to verify something a script
can verify.

Forbidden imports and architectural boundaries are `pnpm check:boundaries`. Reviewer does
not check them.

Validation agents report evidence instead of silently repairing implementation.

Validation agents return findings as JSON matching `.claude/rules/handoff.schema.json`.

A development lane reports its own work with `.claude/rules/lane-handoff.schema.json`, which
is a different contract: a finding is about someone else's work, a lane handoff is about the
lane's own. `DONE` requires a commit, changed files inside the lane's declared paths, and no
unverified acceptance criteria. Deferred, skipped and unknown are all unverified.

`DONE` is a claim about evidence, not about a green exit code. Every acceptance criterion
carries its own expected, actual and result, and a command that did not exercise a criterion
is not evidence for it. The `report-handoff` skill is how a handoff is written; the checks
`pnpm lanes handoff` enforces are listed there.

Structured log records are a fourth evidence source alongside tests, commands and read-back,
cited by `eventId`. A log never authorizes its own success. The `structured-logging` skill is
the contract for emitting them and for citing them.

## Dispatch

Sequential execution is the default. Parallel is an exception a batch earns against the
fifteen requirements in `pnpm lanes decide`, and unknown counts as false.

Never dispatch by judgement. Run `pnpm lanes wave <phase>` and follow the
`execution_decision`. The `dispatch-lanes` skill is the procedure.

A lane writes only inside its `allowed_paths`. Widening its own boundary is never the answer;
`BLOCKED` naming the path is.

Integration is sequential, in dependency order, whatever the dispatch mode was. Worktrees and
branches are never deleted automatically.

Who runs, and when, is `.claude/rules/agent-activation.json`. Agents are conditional tools,
not a mandatory pipeline. Do not run Architect, Validator and Reviewer after every minor edit.

## Product claims

Recommendations are hypotheses with counterevidence, never assertions.

Say "attested success rate", never "measured success rate". The caller asserts the outcome;
LenGentic has no independent way to verify it.

LenGentic observes chosen options and attested outcomes. It does not observe
counterfactuals. It may never claim a decision "does not require an LLM".

Every deterministic recommendation carries a `counterexamples` field. The field may be
empty; it is never omitted.

When implementing analyzers, write the negative fixtures before the positive path. False
positives are the failure mode that kills a recommendations product.

## Commands

```bash
pnpm gates              # lint, format, typecheck, test, build, boundaries
pnpm gates:full         # gates + check:isolation (slow; CI and pre-commit only)
pnpm check:boundaries   # dependency-cruiser
pnpm check:isolation    # builds the platform with playground/ deleted
pnpm spike              # Phase 0 thesis spike (disposable, deleted end of Phase 5)
pnpm check:integrity    # QA-integrity scan: false green, focused tests, hidden skips
pnpm --filter @lengentic/api test <substring>   # one test file, by path substring (vitest)
pnpm oracle waves       # dependency fan-out; which packets can run in parallel now
pnpm oracle packet <id> # the sliced brief for one work packet
pnpm lanes wave <n>     # sequential-vs-parallel decision for the next wave of a phase
pnpm lanes check <id>   # pre-commit lane gate: did the lane stay inside its paths
pnpm lanes handoff <f>  # is this handoff real: schema, commit, ownership, evidence
pnpm lanes integrate    # pre-integration gate + ordered integration plan
pnpm check:lanes        # the dispatch rules' own scenarios (CI; not in `pnpm gates`)
pnpm kb search <words>  # rank every document section; returns file:line citations
pnpm kb show <target>   # one section verbatim — §19 | phase 5 | FILE.md#heading | heading
pnpm kb term <name>     # CONTEXT.md definition + where the word is really used
pnpm kb stale           # notes past review-by; generated files behind their source
pnpm check:kb           # the retriever's own scenarios (CI; not in `pnpm gates`)
pnpm check:probes       # probe hygiene: can a node report DONE on another node's work
pnpm hash:5a <label>    # hash the 5a files an analyzer packet must not change
                        #   …--compare <earlier-label> fails naming every drifted path
```

`check:lanes`, `check:kb` and `check:probes` are out of `pnpm gates` on purpose: they read
`.claude/`, the documents and `scripts/oracle/graph.json`, and `pnpm gates` must keep working
with the engineering harness deleted.

**The oracle must not lie.** A probe records what is on disk and the oracle turns that into
`DONE`, so a probe another node's deliverable can satisfy is a packet that reports finished
before it starts — and it reads exactly like work that is done. One rule, enforced by
`pnpm check:probes`: a probe may only look inside the surface its own node owns. It is not
theoretical; it had already eaten both wave-3 analyzer packets and would have eaten most of
Phase 3. Proof: `.artifacts/evidence/5a/oracle-lint-proof.md`.

## Agents

The main session is the **Coordinator**. There is no coordinator agent.

Roles live in `.claude/agents/`; each file states its own posture and boundary. The
delivery loop and escalation triggers are `MVP_PLAN_V3.md` §9 and `docs/PARALLEL_EXECUTION.md`.

No subagent is told "read the plan." It gets a work packet — `pnpm oracle packet <id>`.

Run the deterministic gates before dispatching any validation agent. They cost nothing and
catch a large share of what an agent would otherwise spend tokens discovering.

No agent issues the final verdict on its own work. Builder reports what it built and what it
ran; the main session accepts it, after whichever gates
`.claude/rules/agent-activation.json` requires for that change class.

## Communication

Be extremely concise. Sacrifice grammar for concision. Bullets and fragments over prose, no
restatement of the question.

Never omit failures, uncertainty, blockers, or validation evidence.

Store detail in artifacts under `.artifacts/`; return paths, not pasted content.

Concision applies to what you add, never to what you observed. Captured output — commands,
exit codes, stack traces, payloads, assertion diffs, failing test names — is quoted
verbatim wherever it lands. Trim only for length, and say where you cut.

## Plan Mode

Make plans extremely concise. Sacrifice grammar for concision.

End with unresolved questions, if any.

Last section: numbered implementation steps.

## Current state

Phase 0 complete — thesis validated, all nine fixture groups produce agreed verdicts.
Phase 1 complete and approved — gates, isolation, Docker runtime and integration tests all
re-verified against a live stack.

**Execution order was amended at the Phase 1 gate: `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`.**
Phase numbers are identity, not sequence. See the amendment in `MVP_PLAN_V3.md` Part III for
the rationale and the two rejected alternatives. `5a` is Phase 5 waves 1–3 — the pure analysis
engine, no database, no HTTP, no SDK, no UI. `5b` is waves 4–6 and stays after Phase 4.

**5a is in progress on branch `phase-5a`, two of three waves landed.**

- **Wave 1 `p5.engine-pkg` — merged** (PRs #2 and #3, `aa9ae67`). The package, the graduated
  types with the three renames, `src/gate-contract.ts` with no `src/gates.ts` beside it, and
  `src/config.ts` holding frozen, injectable thresholds.
- **Pre-dispatch commit `121b699`.** Not a formality: a council review and an adversarial
  semantics review found four defects, each of which would have shipped a green that lies.
  (1) The threshold-binding spec could not fail — every `D` fixture sits far from every
  threshold, so `docs/decisions/0004` was unpaid by construction. Fifteen `B1`–`B5` boundary
  groups now sit **on** the thresholds, and the acceptance criterion is five reds under a
  flipped operator, not a landed file. (2) The grid's `counterexamples` column counted minority
  rows rather than §20.1's dominant-option failures plus minority-option successes; seven of
  twelve rows corrected, `D6` said 2 where the honest count is 22. (3) `R5`'s timeline is
  pinned to `F(A) F(A) S(B) F(A)` — two of the three readings bound nothing — and `Same runId`
  became a §20.2 condition. (4) Two oracle probes reported their packets `DONE` before they
  started.
- **Wave 2 `p5.negative-fixtures` — landed green** at `a863346`. 136 tests, four files. Gutting
  the comparators turns 34 red; corrupting one expectation cell turns 4 red. Evidence:
  `.artifacts/evidence/5a/negative-fixtures-mutation.md`.
- **Wave 3 is next and has not started:** `p5.det-candidate`, then `p5.repeated-failed`.
  Serial — they collide on `src/**` and `test/analyzer/**`. Run
  `pnpm hash:5a before-<packet>` and `--compare` around each; the threshold-binding spec sits
  in a path both of them own, so `allowed_paths` cannot protect it.

**The most transferable thing 5a has learned: two independent blind computations agreed, cell
for cell, on a `counterexamples` column that was wrong.** Agreement proved they had not copied
each other. It did not prove they were right, and only an adversarial pass with a different
question caught it — `.artifacts/evidence/5a/fixture-semantics-review.md`. Treat cross-agent
agreement as evidence of independence, never of correctness.

Three rules bind every remaining 5a packet. The grids in `MVP_PLAN_V3.md` Phase 5 are the
**only** legal source for an expected value — not `pnpm spike`, not `src/`, and `spike/` now
disagrees with the grid on seven rows by design. Wave 2 landed **green**, because
`pnpm lanes handoff` refuses `DONE` on any failing test, so expectations ship as data in
`fixtures/**` with a comparator in `test/grid/**`. And the analyzer packets own `src/**` and
`test/analyzer/**` and cannot edit either.

Phase 1's carried debt (file-based handoffs OD-5, pre-commit hook, secret detection) runs
**after 5a and before Phase 2** — human decision, 2026-08-16.
