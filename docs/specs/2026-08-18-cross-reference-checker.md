# Cross-reference checker — design

Status: accepted, unbuilt. Date: 2026-08-18. Supersedes the "claim ledger" design in
`.artifacts/plans/decision-graph-second-brain.md`, which the council rejected on 2026-08-18.

## The decision this must stop being made wrongly

An agent reads a work-packet brief, believes a fact restated in it, and acts on the stale copy.
On 2026-08-18 that nearly deleted `spike/` — `CLAUDE.md:278` said `p5.spike-deleted` was a 5a
deliverable, `MVP_PLAN_V3.md:2236` puts it in the 5b Definition of Done, and nothing linked them.

The tool is a **cross-reference checker**, not a second brain and not a RAG. It links documents
that already exist and goes RED when a live cross-reference is wrong.

## Scope

Dev harness only. `.claude/`, `scripts/`, and the markdown corpus.

The product half of the original request — a decision graph inside LenGentic — is **out**, by
decision on 2026-08-18. LenGentic already is a decision-observation system: §18 aggregates by
group key, §19 gates, §20.1 collects counterexamples, §21 renders. Redesigning it while
implementing it is what `CLAUDE.md` `## Plan discipline` forbids. The product half goes to
`BACKLOG.md` and reaches the human as escalation trigger 2 if anyone revives it.

`pnpm check:isolation` Arm 2 is untouched: nothing under `platform/` or `playground/` ever
references this. Precedent is `check:lanes`, `check:kb` and `check:probes`, which already read
`.claude/` and the documents and are already outside `pnpm gates`.

## What was rejected, and why

A hand-maintained **claim ledger** — a sidecar YAML of `{key, value, source, quote}` entries with
a same-key/different-value conflict check, grown by hand after each contradiction.

Five council advisors and three peer reviews rejected it on one argument, reached independently:
**the conflict check is circular.** It fires only when a human has already typed both sides of a
contradiction under the same key, which requires already knowing about it. Combined with
"add an entry only after it bit you", its coverage is exactly the set of already-fixed bugs, and
a fixed prose contradiction in a one-human repo almost never recurs. Forward hit rate ≈ 0.

The second failure named was invocation. A fifth opt-in `check:*` command is a fifth thing that
runs only when remembered, and an uninvoked checker is indistinguishable from a passing one.

Both objections are answered below: claims are derived rather than typed, and the checker runs
inside commands that already run.

## What the council got wrong

Every advisor assumed `scripts/oracle/graph.json`'s `phase` field would catch defects 2 and 3.
It does not. All eight phase-5 nodes carry `phase: 5`; no node in the graph has any field
distinguishing 5a from 5b. The split exists only in prose.

That was found by running the check rather than by asking a sixth agent. It is the same lesson
`.artifacts/evidence/5a/fixture-semantics-review.md` records: agreement across independent agents
is evidence of independence, never of correctness.

Consequence: the sub-phase data must be authored before checks A and B can exist. That cost is
priced below rather than hidden.

## The three defects, honestly classified

| #   | Defect                                                                            | Shape            | In scope |
| --- | --------------------------------------------------------------------------------- | ---------------- | -------- |
| 1   | `CLAUDE.md` "validation gate" vs the plan's "human approval gate", nine phrasings | meaning drift    | **No**   |
| 2   | `CLAUDE.md:278` put `p5.spike-deleted` in 5a; `MVP_PLAN_V3.md:2236` puts it in 5b | packet/phase     | Yes      |
| 3   | `graph.json` briefed a 5a packet as producing "§21 output"; §21 is 5b             | section citation | Yes      |

Defect 1 is **explicitly out**. A disagreement about what a rule means, spread over nine
phrasings, defeats string matching, key comparison and generation alike. Claiming otherwise would
put an unbindable checkbox in a Definition of Done — the exact defect the 5a recovery was for.
It is filed to `BACKLOG.md`, not counted here.

The original plan's claim that all three defects "are the same shape" is withdrawn. Three
defects, two shapes, one of them unreachable.

## Design

### Data prerequisite — `subphase`

Add an optional `subphase` field to `graph.json` nodes where a phase is split. Today that is the
eight `phase: 5` nodes, each becoming `"5a"` or `"5b"`, sourced from `MVP_PLAN_V3.md` Part III's
amendment and `.artifacts/plans/remaining-roadmap.md`.

Harness data on nodes that already exist. Reversible. No `MVP_PLAN_V3.md` change, so plan
discipline is not engaged.

A second table maps each `§NN` to its sub-phase for split phases. It does not exist yet and must
be authored; the plan's own headings do not carry it, because §18–§21 live in Part I/II, above
`# PART III — PHASES` at `MVP_PLAN_V3.md:1257`.

### Check A — packet/phase agreement

Any line in any tracked `.md` containing a `p<N>.<slug>` token together with a phase or sub-phase
token must agree with that node's `phase`/`subphase`. A `p<N>.<slug>` token naming no node at all
is also RED.

Catches defect 2. Corpus today: 40+ packet-id mentions across the documents.

### Check B — section citation

A `graph.json` node may not cite a `§NN` whose sub-phase differs from the node's. Applies to the
node's `title`, `note` and `sections`.

Catches defect 3. Corpus today: 29 `§NN` references inside nodes, 221 across the documents.

Precision note, measured before this spec was written: the naive form of this rule — "a node may
only mention sections in its own `sections` list" — produces a false positive on
`p5.negative-fixtures`, which legitimately explains §20.1 in its `note` while `sections` lists
what `pnpm oracle packet` should slice. `sections` is a slice manifest, not a mention whitelist.
Check B compares sub-phase, never the slice manifest.

### Check C — anchor

Every `FILE.md:NNNN` citation appearing in a tracked document must resolve: the file exists, the
line exists, and the line still resembles what the citing sentence said about it.

No authoring cost and the widest reach of the three. This is the check that fires on edits nobody
made with the checker in mind.

### Where it runs

Two places, both already invoked:

- Folded into `pnpm check:kb`, which CI already runs. No fifth `check:*` command.
- Inside `pnpm oracle packet <id>`, so a brief that fails A or B cannot be dispatched. Defect 2
  did its damage at consumption time, not at commit time.

Wire the pre-commit hook when the Phase 1 debt batch lands it. Do not block on that.

## What proves it works

Three retro fixtures, each a repository state restored from history, each of which must turn the
checker RED:

- F2 — `CLAUDE.md:278`'s original text, against a graph carrying `subphase: "5b"`. Check A.
- F3 — the `graph.json` brief citing "§21 output" on a 5a node. Check B.
- FC — a document citing `FILE.md:NNNN` where the line no longer says what was cited. Check C.

A fixture that stays green is a failed acceptance criterion, not a passed one.

**Precision is a first-class result, not an afterthought.** Before any check is wired into CI,
run it over the current tree and over the 57 commits of history, and record every hit with a
verdict: real defect, or false positive. A checker with unmeasured precision trains the reflex of
silencing it. The `§20.1` false positive above is the first entry in that record.

Evidence lands in `.artifacts/evidence/second-brain/`.

## Non-goals

- No LLM step. `CLAUDE.md` `## Verification`: never ask an agent to verify what a script can.
- No hand-typed claim ledger.
- No RAG, no embeddings. `pnpm kb search` already ranks the corpus.
- No generation of `CLAUDE.md` from `MVP_PLAN_V3.md`. One advisor proposed it; a reviewer
  refuted it with this repository's own history — in defect 1 the plan was the **stale** side,
  nine places wrong, and `CLAUDE.md` was right. Generation needs an argument for which document
  is the source, and "the longer one wins" is not that argument.
- No safety interlock requiring a destructive step to cite a live key. It needs the agent to
  consult the ledger voluntarily, which is a judgement step; the same agent that believed the
  stale line would cite the stale key.

## Cost

Check C: about half a day, no data authoring.
Checks A and B: about a day, most of it authoring `subphase` and the §→sub-phase table.

Not a phase. No `MVP_PLAN_V3.md` change. It does not enter the approved execution order and must
not delay the Phase 1 carried debt or Phase 2.

## Open questions

- Does the §→sub-phase table have an owner once phases beyond 5 are split, or does it rot the way
  the rejected ledger would have?
- Check C's "still resembles what the citing sentence said" needs a concrete rule. Exact-substring
  is brittle and trains silencing; heading-identity is looser and may miss real drift.
- Should Check A's proximity rule be line-scoped or sentence-scoped? Line-scoped is simpler and
  was not measured against the corpus.

## Implementation steps

1. Author `subphase` on the eight `phase: 5` nodes in `scripts/oracle/graph.json`.
2. Author the §→sub-phase table for §18–§21.
3. Build Check C, plus fixture FC. Measure precision over the current tree; record every hit.
4. Build Check A, plus fixture F2. Measure precision.
5. Build Check B, plus fixture F3. Measure precision.
6. Fold all three into `pnpm check:kb` and into `pnpm oracle packet <id>`.
7. Replay the checker over the 57 commits of history and record the hit rate in
   `.artifacts/evidence/second-brain/`.
8. File defect 1's meaning-drift shape, and the product-half decision graph, to `BACKLOG.md`.
