---
name: review-diff
description: Review a diff on two axes in parallel — Standards (correctness, architecture fit, maintainability) and Scope (does it match the phase Definition of Done). Use before a commit, at a phase gate, or when handing work to Reviewer.
---

# Review Diff

Two axes, reviewed **separately and in parallel**, then reported side by side.

A change can follow every standard while implementing the wrong thing, and can implement
exactly the right thing while fighting every pattern in the repo. Reporting the axes
together lets a pile of style nits bury the scope finding — and the scope finding is the one
nobody else in the loop performs.

## 1. Pin the fixed point

```bash
git diff --stat && git diff              # uncommitted
git diff --cached                        # staged
git diff main...HEAD                     # a branch, against the merge-base
```

Confirm the ref resolves and the diff is non-empty **before** dispatching anything. A bad
ref discovered inside two sub-agents costs two sessions to learn one fact.

Read the whole diff. A review of the first three files is a review of the first three files.

## 2. Find the spec source

In order: the work packet the change came from (`pnpm oracle packet <id>`), a path given as
an argument, the phase's Definition of Done in the plan. If none exists, the Scope axis says
so rather than inventing a standard to measure against.

## 3. Dispatch both axes in parallel

One message, two sub-agents. They must not see each other's findings.

**Standards sub-agent** — give it the diff command, the commit list, and this brief:

> Report, per file and hunk: correctness defects (error paths, boundary values, the
> dependency being unavailable); architecture fit — does this follow a pattern already in
> the repo or invent a parallel one; maintainability — will the next reader need archaeology;
> and coupling no tool can express — shared mutable state, implicit ordering, a module whose
> imports are clean but which cannot function without another's internals.
>
> Project traps to check by name: a Prisma type escaping the persistence layer; `platform/`
> reaching into `playground/` conceptually even where imports are clean; the SDK importing
> anything but `platform/shared`; the string "measured success rate" anywhere user-facing —
> it must be "attested"; a recommendation path where `counterexamples` can be absent (empty
> is fine, absent is not); a test that would still pass if the implementation were deleted.
>
> Skip anything tooling already enforces. Under 400 words.

**Scope sub-agent** — give it the diff command, the commit list, the packet or Definition of
Done, and this brief:

> Report: (a) what the Definition of Done asked for that is missing or partial; (b) changes
> present in the diff that it did not ask for — later-phase work, unrelated refactors riding
> along, new dependencies with no stated justification; (c) requirements that look
> implemented but where the implementation does not match what was asked. Quote the
> Definition-of-Done line for each finding. Under 400 words.

## 4. Aggregate without reranking

Report under `## Standards` and `## Scope`, verbatim or lightly cleaned. Do **not** merge or
rerank across them — that reranking is exactly what the separation prevents.

Rank _within_ each axis by severity and lead with the worst. For each finding: file and
line, what is wrong, why it matters, what to do.

End with one line per axis: finding count, and the worst issue in that axis. No single
winner across axes.

## What this skill does not review

Forbidden imports and architectural boundaries — `pnpm check:boundaries` owns those and is
better at them. Lexical QA-integrity patterns — `pnpm check:integrity`. Lint and formatting —
already run. Restating a tool's output buries the real findings underneath it.

## Report and hand back

Do not fix anything. A reviewer who quietly fixes a finding has destroyed the separation the
role exists for, and afterwards nobody can tell which findings were real.

If the diff is sound, say so in one line. A manufactured finding trains everyone to skim.
