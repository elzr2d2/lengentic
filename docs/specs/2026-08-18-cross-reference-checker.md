# Cross-reference checker — design

Status: accepted, unbuilt. Date: 2026-08-18. Revised 2026-08-18 after review — three open
questions closed, Check C's rule corrected, one of this document's own citations found wrong.
Supersedes the "claim ledger" design in `.artifacts/plans/decision-graph-second-brain.md`,
which the council rejected on 2026-08-18.

## The decision this must stop being made wrongly

An agent reads a work-packet brief, believes a fact restated in it, and acts on the stale copy.
On 2026-08-18 that nearly deleted `spike/`. `MVP_PLAN_V3.md:2262` puts the packet in the **5b**
Definition of Done, while `scripts/oracle/graph.json` gives the node `needs: ["p5.det-candidate"]`
and nothing else, so it read as available at the 5a gate. Nothing linked the two.

**This paragraph's first draft cited `CLAUDE.md:278` as the stale side. That citation was wrong on
the day it was written** — at `8ce66d5`, the commit that added this file, line 278 was part of the
`8808bc9` recovery note and said nothing about `p5.spike-deleted`. The claim survived a council
review, three peer reviews and acceptance. It is the cheapest available argument that this tool is
worth building, and it is why Check C ships first.

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
| 2   | `p5.spike-deleted` read as 5a-available; `MVP_PLAN_V3.md:2262` puts it in 5b      | packet/phase     | Yes      |
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

**The table lives beside `graph.json`, not as a free-standing document, and the change that
introduces a split owns its partition.** Once any node in a phase carries `subphase`, validation
requires all three of:

- every node in that phase has a recognized sub-phase;
- every numbered section cited by those nodes maps to exactly one sub-phase;
- every mapped section exists in `planRef`.

A future phase split therefore cannot pass `check:kb` until its partition is complete. The owner is
the change introducing the split, never a person expected to remember later. This closes the first
open question: the table cannot rot the way the rejected ledger would have, because an incomplete
partition is RED rather than silent.

### Check A — packet/phase agreement

Any **sentence** in any tracked `.md` containing a `p<N>.<slug>` token together with a phase or
sub-phase token must agree with that node's `phase`/`subphase`. A `p<N>.<slug>` token naming no
node at all is also RED.

Sentence-scoped, not line-scoped. A physical Markdown line is formatting, not meaning; this corpus
is hard-wrapped at 100 columns, so a line boundary falls wherever the wrap happened to land. The
scanner parses Markdown blocks, protects dotted packet ids from the splitter before segmentation,
and treats a table row and a heading each as one assertion unit.

It needs a narrow suppression, because a sentence that deliberately restates an old contradiction
is correct prose and permanently RED without one. `CLAUDE.md`'s own `p5.spike-deleted` note and
this document's opening section are both such sentences — the motivating history makes the current
corpus RED forever otherwise. The suppression is per-sentence, carries a required reason string,
and every use is listed in the precision record. An unreasoned blanket ignore is the silencing
reflex this design exists to avoid.

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

Two citation forms, checked differently. The single-form version in this document's first draft
is withdrawn: a bare `FILE.md:NNNN` carries no machine-readable statement of what the citer
expected, so "still resembles what the citing sentence said" is not deterministically
implementable, and fixture FC could not have been written against it.

- **Bare citation** — `FILE.md:NNNN`. Verify only that the file exists and the line exists.
- **Bound citation** — `FILE.md:NNNN ("expected fragment")`. Find the Markdown block containing
  that line, strip formatting, collapse whitespace, and require the normalized fragment as an
  exact substring of the normalized block.

Block-scoped rather than line-scoped, so a re-wrap does not fire. Exact-substring rather than
paraphrase-aware, so the check never pretends to understand meaning. Heading identity is useful
for locating a citation stably, but it cannot detect changed meaning under an unchanged heading,
so it is not the rule.

**Historical citations must be commit-qualified or explicitly exempted**, with the reason
recorded. A citation to text that has since been rewritten on purpose is not a defect; a citation
that silently drifted is. Without this rule the corpus goes RED on its own accurate history.

**The claim of "no authoring cost" is withdrawn.** Binding a citation costs a quoted fragment at
authoring time, and the existing corpus needs a migration pass to bind the citations worth
binding. Bare citations stay legal and stay cheap, which keeps that migration incremental rather
than all-or-nothing.

Still the widest reach of the three, and still the check that fires on edits nobody made with the
checker in mind. `CLAUDE.md:288` carries a bound-form citation today — it quotes what
`MVP_PLAN_V3.md:2236` says — and that line has since moved to 2262. Live Check C turns it RED now.

### Where it runs

Two places, both already invoked:

- Folded into `pnpm check:kb`, which CI already runs. No fifth `check:*` command.
- Inside `pnpm oracle packet <id>`, so a brief that fails A or B cannot be dispatched. Defect 2
  did its damage at consumption time, not at commit time.

Wire the pre-commit hook when the Phase 1 debt batch lands it. Do not block on that.

## What proves it works

Three retro fixtures, each a repository state restored from history, each of which must turn the
checker RED:

- F2 — the original text at `CLAUDE.md:278`, against a graph carrying `subphase: "5b"`. Check A.
- F3 — the `graph.json` brief citing "§21 output" on a 5a node. Check B.
- FC — a document carrying a **bound** citation whose enclosing block no longer contains the
  quoted fragment. Check C. The live `CLAUDE.md:288` citation of `MVP_PLAN_V3.md:2236` is the
  fixture; no history restore is needed.
- FC-bare — the same citation with the fragment removed must stay **green**, proving the bare form
  is not silently held to the bound rule.

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

Check C: about a day. Half of that is the checker; the rest is the migration pass that binds
existing citations and commit-qualifies the historical ones. The earlier "no data authoring"
estimate assumed the withdrawn single-form rule.
Checks A and B: about a day and a half — `subphase`, the §→sub-phase table, the partition
validation, and the sentence segmenter with its suppression list.

Not a phase. No `MVP_PLAN_V3.md` change. It does not enter the approved execution order and must
not delay the Phase 1 carried debt or Phase 2.

## Questions closed on review, 2026-08-18

- **Table ownership** — closed. The partition is validated, and the change introducing a split
  owns it. See `### Data prerequisite`.
- **Check C's rule** — closed, and the single-form design corrected. Bare citations check
  existence; bound citations check a quoted fragment against the normalized enclosing block. This
  was the one required design correction: fixture FC was not implementable without it.
- **Check A's scope** — closed. Sentence-scoped, over parsed Markdown blocks, with a
  reason-required per-sentence suppression.

## Still open

- The suppression list is a silencing mechanism with a reason attached. Nothing yet caps its size
  or reviews it. If it grows past a handful of entries, Check A is measuring the list rather than
  the corpus.

## Implementation steps

1. Build Check C's two forms, plus fixtures FC and FC-bare. Measure precision over the current
   tree; record every hit. This ships first — it needs no authored data, and this document's own
   wrong citation is the argument.
2. Migration pass: bind the citations worth binding, commit-qualify or exempt the historical ones,
   record each exemption's reason.
3. Author `subphase` on the eight `phase: 5` nodes in `scripts/oracle/graph.json`.
4. Author the §→sub-phase table for §18–§21, beside `graph.json`.
5. Build the partition validation — all three rules in `### Data prerequisite` — and prove it RED
   against a deliberately incomplete partition.
6. Build Check A's sentence segmenter and suppression, plus fixture F2. Measure precision.
7. Build Check B, plus fixture F3. Measure precision.
8. Fold all three into `pnpm check:kb` and into `pnpm oracle packet <id>`.
9. Replay the checker over the 57 commits of history and record the hit rate in
   `.artifacts/evidence/second-brain/`.
10. File defect 1's meaning-drift shape, and the product-half decision graph, to `BACKLOG.md`.
