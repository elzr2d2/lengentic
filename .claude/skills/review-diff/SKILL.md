---
name: review-diff
description: Review uncommitted or branch changes for correctness, architecture fit, maintainability, and scope against the current phase Definition of Done. Use before a commit or when handing work to Reviewer.
---

# Review Diff

## Get the diff

```bash
git diff --stat && git diff
```

For staged work use `git diff --cached`. For a branch, `git diff main...HEAD`.

Read the whole diff before forming an opinion. A review of the first three files is a
review of the first three files.

## What to look for

**Correctness.** Does it do what it claims? Error paths, boundary values, the case where
the thing it depends on is unavailable.

**Scope.** Is every change required by the current phase's Definition of Done? Work that is
good but belongs to a later phase is a finding. So is an unrelated fix riding along in the
diff where review will not see it.

**Architecture fit.** Does this follow the patterns already in the repo, or invent a
parallel one? A second way of doing an existing thing is a finding.

**Coupling tooling cannot see.** Shared mutable state, implicit ordering assumptions, a
module whose imports are clean but which cannot function without another's internals.

**Project-specific traps:**

- A Prisma type escaping the persistence layer.
- Anything importing `platform/api/**` or `platform/analysis-engine/**` from
  `playground/**`.
- `platform/telemetry-sdk` importing anything but `platform/shared`.
- The string "measured success rate" anywhere user-facing. It must be "attested".
- A recommendation path where `counterexamples` can be absent. Empty is fine; absent is not.
- Tests that would still pass if the implementation were deleted.

## What NOT to look for

Forbidden imports and phase boundaries — `pnpm check:boundaries` owns those and is better
at them than you.

Formatting and lint — the tools already ran. Restating their output buries your real
findings.

## Report

Rank by severity, lead with the worst. For each: file and line, what is wrong, why it
matters, what to do.

Do not fix anything. Report and hand back — MVP_PLAN.md §27.

If the diff is sound, say so in one line. A manufactured finding trains everyone to skim.
