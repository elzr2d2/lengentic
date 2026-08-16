# Research notes

External facts, gathered once, with a date on them.

A research note answers a question this repository could not answer from its own code:
what a library does, what a paper claims, what a competitor ships, what a tool's current
API looks like. It is **not** a decision. A decision that came out of a note goes to
`docs/decisions/`, and the note becomes its citation.

## Every note carries three dates' worth of provenance

```text
source        where the facts came from, specifically enough to re-check
researched    the date the facts were true
review-by     the date after which nobody may cite this note without re-checking
```

Front matter, at the top of every file:

```text
---
title:      <what question this answers>
source:     <URL, repo, paper, or person — the primary one>
researched: YYYY-MM-DD
review-by:  YYYY-MM-DD
status:     current | stale | archived
---
```

## Review-by is the whole point

A note without an expiry becomes a permanent cache of facts that were true once. That is
worse than no note: it reads as current, and a later session will act on it.

Past `review-by`, a note is **stale**. Three legal moves, and no fourth:

```text
revalidate   re-check the source, update the facts, push review-by forward
archive      set status: archived, say what replaced it, leave the file
delete       the question stopped mattering
```

Nothing else. "It is probably still fine" is not one of the moves.

Default `review-by` is **90 days** after `researched`. Shorten it for anything that
tracks a fast-moving tool version or a model's behaviour. Lengthen it only for a
published paper, which does not change after publication — though what the field
believes about it does.

## A note is used only when something points at it

Existing on disk does not put a note into a session. A note earns its way into context
because a work packet, a decision record, or a human named it. This is the same rule the
skills follow: disclose on demand, never by default.

So a note that nothing points at is not free — it is a file that will be found by
accident, at full context cost, at the worst moment. If nothing points at a note, that
is a reason to check whether it should still exist.

## Naming

```text
docs/research/YYYY-MM-DD-<short-slug>.md
```

The date in the filename is `researched`, so staleness is visible from a directory
listing without opening anything.

## What is not a research note

| It is                          | It goes to        |
| ------------------------------ | ----------------- |
| a term this project uses       | `CONTEXT.md`      |
| a settled trade-off            | `docs/decisions/` |
| an idea for later              | `BACKLOG.md`      |
| a contract this code must meet | `MVP_PLAN_V3.md`  |
| evidence from a run            | `.artifacts/`     |

## Index

| Note                                                                            | Researched | Review by  | Status  |
| ------------------------------------------------------------------------------- | ---------- | ---------- | ------- |
| [Matt Pocock — AI engineering method](2026-08-16-matt-pocock-ai-engineering.md) | 2026-08-16 | 2026-11-14 | current |
