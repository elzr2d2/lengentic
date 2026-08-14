---
name: update-backlog
description: Record a valuable idea that is not required by the current phase Definition of Done. Use the moment such an idea appears, instead of expanding the current phase.
---

# Update Backlog

MVP_PLAN.md §8, in full:

> Is it required for the current phase Definition of Done?
> If yes — implement it. If no — `BACKLOG.md`. Do not expand the current phase.

This skill exists because the alternative to writing it down is either losing it or
building it now. Both are worse.

## Test first

**Is it required by the current phase's Definition of Done?** Read the DoD from
`MVP_PLAN.md` before answering — not from memory.

If yes, it is not backlog. Build it.

If no, it goes here even if it is small, obvious, and would take five minutes. Especially
then. Five-minute additions are how a phase doubles.

## Where it goes

`BACKLOG.md` has two sections:

- **Discovered during implementation** — items found while building, with the discovery
  context that makes them actionable later.
- **Environment prerequisites** — blocking, not deferred. Different thing entirely.

The standing post-MVP list lives in `MVP_PLAN.md` §94 and is not duplicated.

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
