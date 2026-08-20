---
name: run-quality-gates
description: Run the deterministic quality gates and report real output. Use before claiming any task complete, before a handoff, and before a commit. Never claim gates pass without running them.
---

# Run Quality Gates

Deterministic checks. No agent judgment is involved or wanted — `CLAUDE.md`: never ask
an agent to verify what a script can verify.

## Which tier to run

| Tier | Situation            | Command                                                              |
| ---- | -------------------- | -------------------------------------------------------------------- |
| T1   | Inner loop, mid-task | the focused check: `pnpm lint`, one test file, one package typecheck |
| T2   | Packet commit        | the pre-commit hook (`scripts/precommit.ts`) — staged-scope ladder   |
| T3   | Wave gate            | `pnpm gates`                                                         |
| T4   | Phase gate, and CI   | `pnpm gates:full`                                                    |

T2 runs itself at `git commit`; do not run gates:full by hand before a packet commit — that
was the old ladder, and it paid `check:isolation` per commit for a question with one answer
per phase.

`pnpm gates` runs lint, format:check, typecheck, test, build, check:boundaries, and
check:integrity.

`pnpm check:integrity` is the QA-integrity scan — focused tests, hidden skips, arbitrary
sleeps, swallowed exceptions, assertions that cannot fail, mocked collaborators in
integration tests. Its `BLOCK` hits fail the gate; its `WARN` hits are prompts to look, and
`watchdog` is the role that looks.

`pnpm gates:full` adds `check:isolation`, which rebuilds the platform in a temp checkout
with `playground/` removed. It is slow by design and is scoped to the phase gate and CI,
not to every completion or commit.

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
- Re-run the full suite after every small edit. Use T1 mid-task.
- Fix a gate failure by weakening the gate. If a threshold or rule is wrong, say so and
  route it, do not quietly relax it.
