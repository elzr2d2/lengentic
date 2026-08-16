---
name: run-quality-gates
description: Run the deterministic quality gates and report real output. Use before claiming any task complete, before a handoff, and before a commit. Never claim gates pass without running them.
---

# Run Quality Gates

Deterministic checks. No agent judgment is involved or wanted — MVP_PLAN.md §29: never ask
an agent to verify what a script can verify.

## Which set to run

| Situation                       | Command                       |
| ------------------------------- | ----------------------------- |
| Mid-task, quick feedback        | `pnpm lint && pnpm typecheck` |
| Before claiming a task complete | `pnpm gates`                  |
| Before a commit, or in CI       | `pnpm gates:full`             |

`pnpm gates` runs lint, format:check, typecheck, test, build, check:boundaries, and
check:integrity.

`pnpm check:integrity` is the QA-integrity scan — focused tests, hidden skips, arbitrary
sleeps, swallowed exceptions, assertions that cannot fail, mocked collaborators in
integration tests. Its `BLOCK` hits fail the gate; its `WARN` hits are prompts to look, and
`watchdog` is the role that looks.

`pnpm gates:full` adds `check:isolation`, which rebuilds the platform in a temp checkout
with `playground/` removed. It is slow by design and is scoped to the commit-ready tier
(§31), not to every completion.

## Procedure

1. Run the command for the situation.
2. **Read the actual output.** Exit code alone is not enough — on Windows PowerShell,
   pnpm's stderr banner is often mistaken for a failure, and a passing run can look red.
3. If anything fails, report the failing command, the file and line, and the real
   expected-vs-actual. Do not summarize a stack trace into "tests fail".
4. If a failure is unrelated to the current task, say so explicitly rather than fixing it
   silently. An unrelated fix buried in a task diff is invisible to review.

## Do not

- Report gates as passing when you did not run them. This is the single most damaging
  thing you can do here — everything downstream trusts it.
- Re-run the full suite after every small edit. Use the quick set mid-task.
- Fix a gate failure by weakening the gate. If a threshold or rule is wrong, say so and
  route it, do not quietly relax it.
