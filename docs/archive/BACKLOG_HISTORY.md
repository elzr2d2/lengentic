# BACKLOG history — addressed entries

Addressed and superseded `BACKLOG.md` entries, moved out of the active backlog so
retrieval ranks open work first. Entries are verbatim, grouped under their original
`## Discovered ...` section headings, and keep their original **Source:** and
**Trigger:** context. The only addition is one **Closed:** line under each moved title
naming the evidence for the classification. Nothing here is deleted history — this
file and `BACKLOG.md` together are the full ledger.

---

## Discovered during Phase 1 (2026-08-14)

### Teach Validator the mutation check

**Closed:** entry body records "**Addressed 2026-08-16** by `.claude/skills/test-at-seams/SKILL.md`", which owns the mutation-check method.

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

## Discovered during agent-harness refinement (2026-08-16)

### Watchdog's lexical scan became a script

**Closed:** title says it — "became a script"; `scripts/check-integrity.ts` / `pnpm check:integrity` own the lexical patterns, wired into `pnpm gates`.

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

**Closed:** title says it — "retired before it was ever written"; the convention was deleted, `pnpm oracle packet <id>` already covers the need.

**Source:** `reflector.md`, superseded by `docs/PARALLEL_EXECUTION.md` §3.

`reflector` carried a 40-line convention for a committed per-PR brief that would let a fresh
agent start from minimal context. `pnpm oracle packet <id>` already does exactly that, from
the plan, without a second document to keep in sync. The convention was deleted rather than
reconciled. If packets ever stop carrying enough context, revive the idea — but as a change
to the oracle, not as a parallel artifact.

## Discovered while building the lane workflow (2026-08-16)

### `diagnostician.md` names commands this repository does not have

**Closed:** verified 2026-08-19 — `.claude/agents/diagnostician.md` is tracked and rewritten for this repository; the phantom `npm run dev` / `:4173` / `:8787` references are gone.

**Source:** `.claude/agents/diagnostician.md:28`.
It instructs the agent to reproduce against `npm run dev` with web on `:4173` and API on
`:8787`. Neither port appears anywhere else in the repository, the package manager is pnpm,
and `docker-compose.yml` exposes 3000/3001. The file is untracked and was imported from
another project. Left alone deliberately — it is uncommitted work in progress — but a
Diagnostician dispatched today would report an environment failure against a URL that never
existed. Fix it before the first non-obvious failure, or the first thing Diagnostician
diagnoses will be itself.

## Discovered while wiring structured logging (2026-08-16)

### `pnpm gates` fails on an untracked local settings file

**Closed:** entry body records "**Addressed 2026-08-16** during the first Docker execution" — the `.prettierignore` fix landed with the Phase 1 Definition of Done work.

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

## Discovered while reproducing DoD #9 (2026-08-16)

### `onModuleInit` reports a connection it never verified

**Closed:** entry body records "**Addressed 2026-08-16** by `e149c86`" — commit verified: "fix: verify database reachability at boot instead of reporting it".

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

## Discovered computing the gate expectation grid (2026-08-16, 5a step 0)

### No fixture sits on a gate threshold — ABSORBED INTO 5a, 2026-08-17

**Closed:** title says it — "ABSORBED INTO 5a, 2026-08-17"; body: "Status: no longer deferred", closed by the `B1`–`B5` threshold boundary rows.

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

### The round-robin `contextKey` cursor scope is unspecified

**Closed:** verified 2026-08-19 — the cursor rule is written where the entry asked: `platform/analysis-engine/fixtures/inputs/expand.ts:44-47` (round-robin by ordinal position across the group; a pinned key still consumes an ordinal).

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

**Closed:** verified 2026-08-19 — the graduated rationales carry no blended rate: `platform/analysis-engine/fixtures/inputs/decision-groups.ts:210-212` (D7) and `:272-274` (D9); the "delete the number from the prose" option was taken.

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

## Discovered at the 5a pre-dispatch step (2026-08-17)

### An oracle probe can report a packet DONE before it starts

**Closed:** entry body records "**Addressed 2026-08-17** by `pnpm check:probes`" (`scripts/lanes.ts probes`); red-then-green proof at `.artifacts/evidence/5a/oracle-lint-proof.md`.

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

## Discovered while auditing how decisions are recorded (2026-08-17)

### `pnpm decide` — one generated index over the six decision stores

**Closed:** entry body records "**Built ahead of the trigger**" — landed as `scripts/decide.ts` + `scripts/decide/selftest.ts` (`pnpm decide`, `pnpm check:decide`).

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

**Closed:** title says it — "adopted now"; body: "**Trigger:** none — in force from 2026-08-17" — a working agreement in force, not open work.

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

## Discovered designing p2.prisma-run-step's schema (2026-08-19)

### ~~`platform/database/src/generated/` is neither tracked nor gitignored~~ — closed, not a bug

**Closed:** entry body records "**Closed 2026-08-19** — verified false"; `platform/database/.gitignore:1` already ignores `src/generated/`.

**Source:** Same Architect pass. **Closed 2026-08-19** — verified false. `platform/database/.gitignore:1`
already ignores `src/generated/`, since Phase 1. `git check-ignore -v` confirms:
`platform/database/.gitignore:1:src/generated/  platform/database/src/generated/foo.ts`. Confirmed
independently by two later passes (`p2.prisma-run-step` builder handoff, and Watchdog on
commits `06508d5`/`ce2b8f5`). No action needed.

### `completionFieldOrigins` doc comment misdescribed its own key structure — caught, not shipped

**Closed:** entry body records "**Trigger:** none — fixed in the same packet at commit `42cbe55`" (commit verified); recorded for the pattern, not as open work.

**Source:** Reviewer finding S-A on `p2.prisma-run-step` lane commit `ce2b8f5`, 2026-08-19
(fresh re-review dispatched to close BACKLOG's `completionFieldOrigins` trigger above).
**Trigger:** none — fixed in the same packet at commit `42cbe55`. Recorded for the pattern, not
as open work.

The doc comment shipped on `ce2b8f5` said the map was keyed "by each key of `metadata`" and was
"Null before any completion event" — both wrong. The map is keyed by `completionFields` key
names (today exactly one: the literal string `"metadata"`), and `merge-rules.ts:74-76` requires
`completionFields` (and by extension the sibling origins map) to be an object, never null, before
completion. A future packet following the comment literally would have serialized per-metadata-key
origins, which cannot rehydrate `EntityMergeState.completionFieldOrigins` — silently reintroducing
the exact arrival-order fallback this column exists to prevent, one layer down and invisible to
`merge-rules.spec.ts`. Worth keeping as a pattern note: a storage-layer fix that is structurally
correct can still ship a spec-shaped defect in its own doc comment, and only a second, deliberately
skeptical review pass (not the same reviewer re-checking their own diagnosis) caught it.

## Discovered during the .claude infrastructure audit (2026-08-19)

### Distinct exit code when `pnpm lanes wave` means "phase finished"

**Closed:** verified 2026-08-19 — landed in `e90f464`; `scripts/lanes.ts:1283` returns `PHASE_COMPLETE` with exit 0 (lanes selftest scenario 46), and `CLAUDE.md` documents the contract.

**Source:** audit §7 item 8 (§5 item 3); `scripts/lanes.ts:1156`. **Trigger:** the next
phase-gate session that scripts around `pnpm lanes wave`.

"No outstanding work in phase N" and "failed" both exit 1; CLAUDE.md already carries a warning
paragraph because this burned a session. Give "finished" exit 0 with its message, or a dedicated
code. One-line fix plus a selftest scenario.
