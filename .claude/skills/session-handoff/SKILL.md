---
name: session-handoff
description: Compress the current session into a continuation brief a fresh session picks up automatically. Use when the dumbzone detector says to hand off, when a task will outlive this context window, or whenever the human asks for a handoff.
---

# Session Handoff

The context window is spent and the work is not. This writes what the next session needs to
continue, so the human can `/clear` without losing the thread.

Not a handoff in this repository's other sense. `handoff.schema.json` is a **finding** about
someone else's work and `lane-handoff.schema.json` is a lane's **evidence** for its own — both
are claims, and both are checked. This is neither. A continuation brief asserts nothing and is
checked by nobody; do not put `evidence`, `result` or `PASS` in it. If you have a real lane
handoff to file, file that first — this does not replace it.

## Where it goes

`.artifacts/handoffs/session/<session_id>.md`, and nowhere else. The path is the contract: a
`SessionStart` hook reads that directory on the next `/clear` or startup and injects the newest
brief. A file in the OS temp directory is a file the hook cannot find.

`.artifacts/` is gitignored, so a brief never leaves this machine and never rides into a commit.

## Shape

Front matter first, exactly these keys. The hook parses `head` to decide whether the brief is
still about the current tree, so a wrong sha is worse than an absent one.

```
---
session_id: <the session id, matching the filename>
task_id: <graph node id from `pnpm oracle packet`, or none>
branch: <git branch>
head: <full sha of HEAD at the moment of writing>
uncommitted: <paths from `git status --porcelain`, or clean>
next_step: <the one thing the next session should do first>
purpose: <what the next session is for>
---
```

Run `git rev-parse HEAD`, `git branch --show-current` and `git status --porcelain` and read the
values off. Do not recall them.

Then the body, in this order:

- **Where the work stands** — what is done, what is in flight, what was decided. Decisions are
  the part nothing else records: a commit shows what changed, never which two options were
  weighed.
- **What is not done** — including anything deliberately skipped, and why.
- **Open questions** — the ones the next session will hit, not every one raised.
- **Suggested skills** — which skills the next session should invoke, by name.

## Pointers, not duplication

Reference artifacts by path: the packet id, the `.artifacts/` run, the failing file and line,
the commit sha. Do not copy their contents in. A brief that restates a diff spends the fresh
window re-reading what is already on disk — adding context to fix a context problem.

Keep it under roughly 150 lines. The hook truncates past 12000 characters and says so, which
means the tail of an oversized brief is the part nobody reads.

Redact secrets — API keys, passwords, tokens, PII. `.artifacts/` is untracked, not private.

## What this does not do

Writing is a human or model action; only injection is automatic. A session that dies at 140K
with nobody invoking this leaves nothing to inject. The hook does not save the work — it makes
saving it cheap.
