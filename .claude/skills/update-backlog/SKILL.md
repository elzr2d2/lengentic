---
name: update-backlog
description: Record a valuable idea that is not required by the current phase Definition of Done. Use the moment such an idea appears, instead of expanding the current phase.
---

# Update Backlog

MVP_PLAN_V3.md §8 (Scope Management Rule), in full:

> Is it required for the current phase Definition of Done?
> If yes — implement it. If no — `BACKLOG.md`. Do not expand the current phase.

This skill exists because the alternative to writing it down is either losing it or
building it now. Both are worse.

## Test first

**Is it required by the current phase's Definition of Done?** Read the DoD from
`MVP_PLAN_V3.md` before answering — not from memory. `pnpm kb show phase <n>` prints it.

If yes, it is not backlog. Build it.

If no, it goes here even if it is small, obvious, and would take five minutes. Especially
then. Five-minute additions are how a phase doubles.

## Batch, then flush

Mid-packet, append the entry to `.artifacts/backlog/pending.md` and return to the task —
editing `BACKLOG.md` (~16k tokens) per idea pays its weight once per idea. At the **wave
gate**, flush everything pending into `BACKLOG.md` in one edit and empty the pending file.

Write straight into `BACKLOG.md` only when the pending file is unsafe — the idea must
survive even if this session dies before the wave gate (a defect shape that will be
re-introduced without the note, a decision someone is about to re-litigate).

## Where it goes

`BACKLOG.md` is organised as dated discovery sections — `## Discovered during <context>
(<date>)`. Append to the current session's section, or start a new one with today's date and
the discovery context. Environment prerequisites (blocking, not deferred — a different thing
entirely) have their own section near the top.

Entries that have since been addressed move to `docs/archive/BACKLOG_HISTORY.md` with a
`**Closed:**` evidence line; never delete one in place.

The standing post-MVP list lives in `MVP_PLAN_V3.md` §27 and is not duplicated.

## Entry shape

```markdown
### Short imperative title

**Source:** where it came from — a fixture, a review finding, a paper, a phase section.

What it is, in two or three sentences. Why it was deferred. What would have to be true for
it to be worth doing. Any decision already ruled out, so the next reader does not
re-litigate it.
```

The `Source` line is what makes an entry survive. An idea recorded without its context is a
sentence nobody can act on six weeks later.

## Then continue

Recording it is the whole action. Do not implement it, do not sketch it, do not add a
`TODO` in code pointing at it. Return to the current task.
