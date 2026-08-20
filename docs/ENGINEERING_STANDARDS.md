# Engineering standards

The single source of truth for **how code in this repository is written**. Every rule below
is stated as observable behaviour and carries the thing that enforces it.

Two claims this document makes about itself, and both are checkable:

1. **A rule appears once.** If a tool enforces it, the tool is the rule and this file only
   describes it. Nothing here is restated in an agent prompt — an agent that has to
   remember a rule a linter already proves is paying attention twice for one answer.
2. **A `[MUST]` has an enforcer.** Either a command that fails, or a named role that owns
   the judgement plus the reason a machine cannot make it. There is no third option.

## What lives elsewhere

| Subject                       | Home                                                    |
| ----------------------------- | ------------------------------------------------------- |
| Which module may import which | `CLAUDE.md` ## Architecture + `.dependency-cruiser.cjs` |
| What a word means here        | `CONTEXT.md`                                            |
| What the product must do      | `MVP_PLAN_V3.md`                                        |
| A settled, costly trade-off   | `docs/decisions/`                                       |
| An idea for later             | `BACKLOG.md`                                            |
| Who runs, and when            | `.claude/rules/agent-activation.json`                   |
| What a handoff must contain   | `.claude/rules/*.schema.json` + `report-handoff`        |

This file cites those; it does not copy them. `pnpm kb search <words>` finds any of them.

## Classification

- **`[MUST]`** — violating it causes a correctness, security, or architecture defect.
  A `[MUST]` with a deterministic enforcer is not negotiable at review time; the command
  fails and the change does not land.
- **`[SHOULD]`** — the default. Deviating is allowed with a concrete reason stated in the
  code or the handoff. "It felt cleaner" is not a reason.
- **`[AVOID]`** — a known smell. Not automatically a defect, and never on its own a reason
  to reject a change that is otherwise correct.

Priority when two rules pull against each other:

> **correct > simple > explicit > testable > reusable**

## The enforcement ladder

Before a rule is written down, it goes down this ladder and stops at the first rung that
can hold it:

1. **TypeScript** — `tsconfig.base.json`
2. **ESLint** — `eslint.config.js`
3. **dependency-cruiser** — `.dependency-cruiser.cjs`
4. **Tests** — the package suites
5. **A deterministic script** — `scripts/check-*.ts`
6. **Reviewer judgement** — and only here

Rungs 1–5 are commands, and most of them are `pnpm gates` — `check:secrets` runs in the
pre-commit ladder instead, and `check:isolation` at the phase gate. Rung 6 costs a
dispatch and a context window, so a rule that
lands there must say why the five above it could not hold it. That reason is in the
**Enforced by** column, not in someone's memory.

---

## TS — the type system

| ID    | Class      | Rule                                                                                                                                   | Enforced by                                                                                                           |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| TS-1  | `[MUST]`   | No `any`. `unknown` at an external boundary, narrowed before use.                                                                      | `@typescript-eslint/no-explicit-any`                                                                                  |
| TS-2  | `[MUST]`   | An `any`-typed value is never called, returned, spread, or passed on unnarrowed.                                                       | `@typescript-eslint/no-unsafe-*` (5 rules, type-aware)                                                                |
| TS-3  | `[MUST]`   | No double assertion `x as unknown as T` outside test doubles.                                                                          | `no-restricted-syntax` selector `TSAsExpression > TSAsExpression`                                                     |
| TS-4  | `[MUST]`   | No assertion that does not change the type.                                                                                            | `@typescript-eslint/no-unnecessary-type-assertion`                                                                    |
| TS-5  | `[MUST]`   | A `switch` over a union handles every member, by name.                                                                                 | `@typescript-eslint/switch-exhaustiveness-check`                                                                      |
| TS-6  | `[MUST]`   | No `enum`. A union of string literals instead.                                                                                         | `no-restricted-syntax` selector `TSEnumDeclaration`                                                                   |
| TS-7  | `[MUST]`   | `@ts-ignore` is banned; `@ts-expect-error` needs a description.                                                                        | `@typescript-eslint/ban-ts-comment`                                                                                   |
| TS-8  | `[MUST]`   | Strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`.                                   | `tsconfig.base.json` — `pnpm typecheck`                                                                               |
| TS-9  | `[MUST]`   | Wire types derive from the Zod schema with `z.infer`; no hand-maintained twin.                                                         | **Reviewer.** A hand-written type that happens to match a schema is indistinguishable from a derived one to any tool. |
| TS-10 | `[SHOULD]` | A discriminated union over a pair of booleans; `readonly` where nothing mutates; `satisfies` over an annotation that erases inference. | Reviewer                                                                                                              |
| TS-11 | `[AVOID]`  | `Record<string, unknown>` as a domain type; an optional field standing in for two states.                                              | Reviewer                                                                                                              |

`as` is allowed exactly when the invariant is proven outside TypeScript — a framework that
types its own return as `any`, a JSON file this repository owns — and the proof is written
next to it. `platform/api/test/health.integration.spec.ts` is the worked example.

## ASYNC — concurrency

| ID      | Class      | Rule                                                                                      | Enforced by                                                                           |
| ------- | ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ASYNC-1 | `[MUST]`   | Every promise is awaited, returned, or explicitly handled.                                | `@typescript-eslint/no-floating-promises`                                             |
| ASYNC-2 | `[MUST]`   | No async function passed where a sync one is expected (conditions, event handlers).       | `@typescript-eslint/no-misused-promises`                                              |
| ASYNC-3 | `[MUST]`   | `await` only thenables; an `async` function that never awaits is not async.               | `await-thenable`, `require-await`                                                     |
| ASYNC-4 | `[MUST]`   | A call that can hang carries a timeout or a cancellation signal.                          | **Reviewer.** "Can hang" is a property of the remote end, not of the call site.       |
| ASYNC-5 | `[MUST]`   | A retryable operation is idempotent; a retry never duplicates an irreversible effect.     | **Tests** at the seam + Reviewer. Which effects are irreversible is domain knowledge. |
| ASYNC-6 | `[MUST]`   | Concurrent lanes never share a mutable write surface.                                     | `pnpm lanes check <id>` (path ownership) + `watchdog`                                 |
| ASYNC-7 | `[SHOULD]` | `Promise.all` only over genuinely independent work; never over writes to one transaction. | Reviewer                                                                              |

## ERR — failure

| ID    | Class     | Rule                                                                                                            | Enforced by                                                                                                                                       |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERR-1 | `[MUST]`  | No silently swallowed exception. A `catch` that neither rethrows, logs, nor returns a domain value is a defect. | `pnpm check:integrity` (BLOCK)                                                                                                                    |
| ERR-2 | `[MUST]`  | Wrapping preserves the original as `cause`.                                                                     | **Reviewer.** A tool cannot tell a dropped cause from one that was never useful.                                                                  |
| ERR-3 | `[MUST]`  | Four classes, kept apart at the boundary: validation, domain, dependency/environment, internal.                 | **Reviewer** + the API error-mapping tests                                                                                                        |
| ERR-4 | `[MUST]`  | No stack trace, secret, or internal identifier in an API response body.                                         | `clientSafeMessage` in `all-exceptions.filter.ts`, exercised by the integration suite only. **Gap: no unit test pins it.** Filed in `BACKLOG.md`. |
| ERR-5 | `[AVOID]` | `catch { return false }` — unless `false` is the domain contract and the failure stays visible somewhere else.  | `check:integrity` (WARN) → `watchdog` reads it                                                                                                    |

## OBS — observability

| ID    | Class      | Rule                                                                                       | Enforced by                                                                                                  |
| ----- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| OBS-1 | `[MUST]`   | Progress and failure are emitted as one structured event with an `eventId`, not as prose.  | `.claude/rules/log-event.schema.json` + `scripts/lib/log.ts`; the `structured-logging` skill is the contract |
| OBS-2 | `[MUST]`   | No secret, token, or credential reaches a log or an artifact.                              | `pnpm check:secrets` (pre-commit step 1)                                                                     |
| OBS-3 | `[MUST]`   | No `[object Object]` in a message. A value interpolated into a log line has a string form. | `no-base-to-string`, `restrict-template-expressions`                                                         |
| OBS-4 | `[MUST]`   | A log record is evidence; it never authorizes its own success.                             | **Reviewer** + `pnpm lanes handoff` evidence check                                                           |
| OBS-5 | `[SHOULD]` | Full payloads are not logged by default. Log the shape, the size, and the identifier.      | Reviewer                                                                                                     |

## TEST — evidence that can fail

| ID      | Class      | Rule                                                                                        | Enforced by                                                                                                                                                        |
| ------- | ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TEST-1  | `[MUST]`   | No arbitrary `sleep` in a test.                                                             | `pnpm check:integrity` (BLOCK)                                                                                                                                     |
| TEST-2  | `[MUST]`   | No focused test (`.only`).                                                                  | `pnpm check:integrity` rule `focused-test` (BLOCK)                                                                                                                 |
| TEST-2b | `[MUST]`   | A skipped test is declared, never hidden.                                                   | `check:integrity` rule `skipped-test` is WARN, not BLOCK — a legitimately skipped test exists and only a reader can tell the two apart. `watchdog` reads the WARN. |
| TEST-3  | `[MUST]`   | An integration test does not mock the collaborator it exists to integrate with.             | `pnpm check:integrity` (BLOCK)                                                                                                                                     |
| TEST-4  | `[MUST]`   | The expected value is sourced independently of the code under test.                         | **Validator** + the `test-at-seams` skill. Provenance is not visible in the assertion — the same literal is correct or circular depending on where it came from.   |
| TEST-5  | `[MUST]`   | For an analyzer, the negative fixtures are written before the positive path.                | **Validator.** `CLAUDE.md` ## Product claims.                                                                                                                      |
| TEST-6  | `[MUST]`   | A test that cannot fail is not a test. It is mutation-checked before it counts as evidence. | **Validator** (hardening lane, below)                                                                                                                              |
| TEST-7  | `[SHOULD]` | Many pure tests, some integration, few end-to-end.                                          | Reviewer                                                                                                                                                           |

## DATA — Prisma and PostgreSQL

| ID     | Class     | Rule                                                                                     | Enforced by                                                                                                                                  |
| ------ | --------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| DATA-1 | `[MUST]`  | A Prisma type never crosses a module boundary. Map explicitly at the persistence edge.   | `no-prisma-in-the-wire-contract` + `analysis-engine-not-to-prisma` (dependency-cruiser) and `no-restricted-imports` for the generated client |
| DATA-2 | `[MUST]`  | Writes that form one invariant happen in one transaction.                                | **Reviewer.** Which writes form an invariant is domain knowledge.                                                                            |
| DATA-3 | `[MUST]`  | An invariant the database owns is enforced by a constraint, not by an application check. | **Reviewer** at migration review — see `agent-activation.json` class `contract`.                                                             |
| DATA-4 | `[MUST]`  | A destructive migration is an escalation, never a decision made in a lane.               | `CLAUDE.md` escalation trigger 1                                                                                                             |
| DATA-5 | `[AVOID]` | A query inside a loop over rows.                                                         | Reviewer                                                                                                                                     |

`no-prisma-in-the-wire-contract` covers `@prisma/client`; the ESLint rule covers deep
imports into `platform/database/src/generated/**`, which the cruiser drops from its graph
before any rule sees it. Both were verified by introducing a violation and watching the
command fail — `.artifacts/evidence/standards/`.

## API and transport

| ID    | Class      | Rule                                                                                 | Enforced by                                                                                                     |
| ----- | ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| API-1 | `[MUST]`   | `platform/shared/schema/**` is the only wire contract; both sides import it.         | `shared-schema-is-the-wire-contract` (cruiser)                                                                  |
| API-2 | `[MUST]`   | No persistence model returned from a controller.                                     | DATA-1 + Reviewer                                                                                               |
| API-3 | `[MUST]`   | A dependency being down is 503, not 500.                                             | `health.integration.spec.ts` — `pnpm test:integration`, needs Docker; not part of `pnpm test`                   |
| API-4 | `[MUST]`   | An unbounded collection is paginated; a body has a size limit.                       | `INGEST_LIMITS` (`platform/shared/schema/limits.ts`) + `test/parse/batch-shape.spec.ts`; pagination is Reviewer |
| API-5 | `[SHOULD]` | A controller does transport only: parse, call, map. Domain logic lives in a service. | Reviewer                                                                                                        |
| API-6 | `[AVOID]`  | `forwardRef()`. It is an escape hatch from a cycle that should have been a boundary. | `no-circular` (cruiser) catches the import cycle                                                                |

## ARCH — boundaries

Stated in `CLAUDE.md` ## Architecture, enforced entirely by `pnpm check:boundaries` and
`pnpm check:isolation`. Not restated here. The rule names are readable in
`.dependency-cruiser.cjs` and each carries its own reason:

`platform-not-to-playground`, `platform-not-to-claude`, `playground-not-to-claude`,
`playground-not-to-api`, `playground-not-to-analysis-engine`,
`playground-sdk-public-entry-only`, `playground-not-to-other-platform-packages`,
`sdk-depends-on-shared-only`, `shared-schema-is-the-wire-contract`,
`no-prisma-in-the-wire-contract`, `analysis-engine-not-to-prisma`,
`analysis-engine-is-pure`, `engine-src-not-to-test-material`,
`engine-fixtures-not-to-analyzers`, `nothing-to-spike`, `no-circular`, `not-to-dev-dep`.

A failing cruise names the rule, the source module, the target module and the path. Reviewer
does not check imports — it is worse at it than the tool, and restating tool output buries
the findings only a Reviewer can produce.

## DESIGN — shape

| ID       | Class      | Rule                                                                                                                            | Enforced by                                                                  |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| DESIGN-1 | `[MUST]`   | An abstraction is introduced when a second real variation exists — not for a hypothetical one.                                  | **Reviewer**, anti-overengineering gate below                                |
| DESIGN-2 | `[MUST]`   | Duplication is removed when both copies are the same domain rule and change for the same reason.                                | **Reviewer.** Textual similarity is not sameness, and a tool only sees text. |
| DESIGN-3 | `[MUST]`   | Cyclomatic complexity ≤ 15 in `platform/**` and `playground/**`.                                                                | `complexity` (ESLint)                                                        |
| DESIGN-4 | `[SHOULD]` | A module's public contract is readable without loading its implementation, and its implementation is deeper than its interface. | **Reviewer** + the `codebase-design` skill                                   |
| DESIGN-5 | `[SHOULD]` | Pure domain rules with I/O at the edge. The analysis engine is the enforced instance of this.                                   | `analysis-engine-is-pure` (cruiser) for that package; Reviewer elsewhere     |
| DESIGN-6 | `[AVOID]`  | `utils.ts`, a `BaseService`, a repository that renames Prisma methods, a wrapper class with no behaviour.                       | Reviewer                                                                     |

### The anti-overengineering gate

Five questions, asked of every new abstraction. Any "no" means keep the concrete code:

1. What concrete problem does this solve **now**?
2. What duplication or coupling does it remove?
3. Is there already a second real consumer?
4. Does it improve testability or enforce a boundary?
5. Is it easier to understand than what it replaces?

Explicitly rejected: an interface with one implementation and no test seam; a factory
wrapping a constructor; a pattern introduced because SOLID names it; DTO mapping across a
boundary that is not a trust boundary.

**Not enforced by any tool, on purpose.** Every mechanical proxy for this — file count,
line count, parameter count — punishes the cohesive code it was meant to protect. It is a
Reviewer judgement and it stays one.

## SEC — security

| ID    | Class    | Rule                                                                | Enforced by                                                  |
| ----- | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| SEC-1 | `[MUST]` | No secret is committed.                                             | `pnpm check:secrets`, pre-commit step 1                      |
| SEC-2 | `[MUST]` | Every external input is validated at the trust boundary before use. | Zod schema at the edge + the rejection tests                 |
| SEC-3 | `[MUST]` | Database access is parameterized. Never string-built SQL.           | Prisma by construction; `$queryRawUnsafe` is a Reviewer stop |
| SEC-4 | `[MUST]` | Credentials come from config, never from a literal.                 | `check:secrets` + Reviewer                                   |

Anything touching credentials, production, privacy or compliance is `CLAUDE.md` escalation
trigger 4 — it stops and asks, whatever this table says.

## PERF

| ID     | Class      | Rule                                                                                                                                            | Enforced by |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| PERF-1 | `[MUST]`   | No speculative optimization. Correctness, then clarity, then a measurement, then the optimization.                                              | Reviewer    |
| PERF-2 | `[SHOULD]` | An algorithmic explosion is a finding even without a benchmark: a query per row, an unbounded accumulation, a repeated expensive recomputation. | Reviewer    |

## REFAC — continuous micro-refactoring

Product work drives refactoring; refactoring does not drive product work. Whenever code is
touched for real product work, the code that was touched is left slightly better than it
was found — and nothing else is touched. Owned by **Builder** while implementing and
**Reviewer** at the gate.

| ID      | Class      | Rule                                                                                                                                                                                                                         | Enforced by                                                                                                                         |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| REFAC-1 | `[MUST]`   | Code directly touched by a change is left compliant with this document where the fix is local and behaviour-preserving. Where it is not, the violation is recorded in `BACKLOG.md` and the product work continues.           | **Reviewer** — whether a fix is local needs the packet's intent. `update-backlog` for the other branch.                             |
| REFAC-2 | `[MUST]`   | A refactor preserves externally observable behaviour unless the active packet requires the behaviour to change. Preservation is shown by the focused tests and the packet validation command, run before and after.          | The focused suite at the tier the change earns (table below). A change that cannot show it is a behaviour change and routes as one. |
| REFAC-3 | `[MUST]`   | A refactor stays inside the blast radius of the work: the function, its module, adjacent code the change needs to be clean, and the tests covering that behaviour. Cross-package refactoring is never routine.               | **Watchdog** scope pass + the lane's `allowed_paths` (`pnpm lanes check <id>`)                                                      |
| REFAC-4 | `[MUST]`   | Debt discovered by a refactor is recorded, not followed. One micro-refactor never opens a second.                                                                                                                            | `update-backlog`; **Reviewer** flags a cascade in the diff                                                                          |
| REFAC-5 | `[SHOULD]` | Order: make the behaviour work, get the evidence green, micro-refactor, re-run the focused validation, commit. A preparatory refactor comes first only when the existing structure makes the change unsafe, and stays small. | **Reviewer**                                                                                                                        |
| REFAC-6 | `[SHOULD]` | The smallest diff that gets the same improvement wins: one function over one module, one module over one package.                                                                                                            | **Reviewer**                                                                                                                        |
| REFAC-7 | `[AVOID]`  | Refactoring only because a cleaner abstraction is imaginable. A new abstraction still has to pass the anti-overengineering gate above.                                                                                       | `DESIGN-1` + the five questions                                                                                                     |

### What a micro-refactor is

Rename a misleading name; extract a repeated domain rule; delete dead code the change
exposed; replace an `any` or an unnecessary cast with a real type or a narrowing; flatten a
deep conditional; add a guard clause; split an overloaded function; remove duplication
inside the touched module; make a side effect explicit; improve error propagation; replace
an unclear boolean parameter; move validation to the correct boundary; tighten an interface
the touched code uses; fix an obvious async or Promise handling defect; improve a test that
cannot discriminate the behaviour being changed.

### What is not one

Rewriting a service, migrating a pattern across the repository, introducing a new
repository/service/factory hierarchy, replacing a library, renaming dozens of files,
restructuring several modules, redesigning a public API, replacing the persistence
architecture, mass style conversion, "apply SOLID to the project", "clean up all the
TypeScript issues", or changing unrelated tests. Each of those is its own justified work
packet, and it is filed, not performed.

### Which violations get fixed in passing

- **`[MUST]` in touched code** — fix it when the fix is local and behaviour-preserving.
  Otherwise `BACKLOG.md`.
- **`[SHOULD]` in touched code** — only when the change is trivial and local.
- **`[AVOID]` in touched code** — never a reason on its own. Improve it only when the
  current change already benefits.

This is what keeps a new standard from becoming a licence for repository-wide cleanup.

### What Reviewer flags, and what it does not

Flags: touched code made materially worse; a local `[MUST]` left behind with no reason
given; complexity the change introduced; an obvious small cleanup skipped where it directly
reduced risk.

Does not flag: unrelated legacy code, repository-wide consistency outside the diff,
improvements that would need a larger refactor, or a theoretical `DESIGN` win with no
current benefit. Those are `BACKLOG.md` entries, not gate findings.

---

## Adaptive validation: how much gate a change earns

Cost is real. Running every gate on every change buys nothing and spends the context that
the next change needs. This repository already classifies changes; the mapping below joins
the two existing mechanisms rather than adding a third.

| Risk        | What it looks like                                                                                                | Change class (`agent-activation.json`) | Gate tier (`run-quality-gates`)                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| **Low**     | Isolated implementation. No public contract, no schema, no concurrency or security boundary.                      | `mechanical` / `feature`               | T1 inner loop → T2 at commit                                          |
| **Medium**  | Cross-module behaviour, a database interaction, real business logic.                                              | `feature` / `behavior`                 | T2, then T3 `pnpm gates` at the wave gate                             |
| **High**    | Public contract, migration, authorization, concurrency or idempotency, an irreversible effect, a boundary change. | `contract` / `behavior`                | T3 per packet, T4 `pnpm gates:full` at the phase gate, plus hardening |
| **Unknown** | Not enough evidence to classify.                                                                                  | treat as `contract`                    | the broader tier. Unknown counts as false — ADR 0002.                 |

T2 is the staged-scope pre-commit ladder (`scripts/precommit.ts`); it already scales itself
to what the commit touches — docs-only commits short-circuit after formatting, and only
affected packages are typechecked and tested. T4 adds `check:isolation`, which is minutes
long and answers a question that has one answer per phase.

**A gate is never weakened to make a change pass.** If a threshold is wrong, say so and
route it; do not quietly relax it. That path is how a green starts lying.

## The hardening lane

A lane, not an agent. It runs **after** implementation, on high-risk work only, and it asks
one question:

> Can the existing evidence detect a fault deliberately introduced into this code?

Not "did the tests pass". A suite that passes against a broken implementation is the
failure this lane exists to find.

**Triggers** — any one is enough (they are the `adversarial-test` and `integrity-scan`
conditions already in `.claude/rules/agent-activation.json`):

- a phase gate covering behaviour or contract changes
- an analyzer, an oracle, or other logic where a false green kills the product
- a repair of a serious false-green defect
- a diff that touches test files and product files together

**What it runs**, all of it already present:

| Question                                  | Command / method                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Do the tests admit a fault?               | manual mutation check per the `test-at-seams` skill                                                                                 |
| Is the suite honest about what it ran?    | `pnpm check:integrity`                                                                                                              |
| Does the boundary hold under deletion?    | `pnpm check:isolation`                                                                                                              |
| Can a node report DONE on another's work? | `pnpm check:probes`                                                                                                                 |
| Does the negative case actually reject?   | the analyzer's negative fixtures                                                                                                    |
| Is anything unreachable?                  | `@typescript-eslint/no-unused-vars`. `noUnusedLocals` is NOT set in `tsconfig.base.json` — dead exports are not currently detected. |

**Mutation testing (Stryker) — evaluated, not installed.** Filed in `BACKLOG.md` with the
condition that reopens it. The short version: the manual mutation check already covers the
analyzer surface where a false green is fatal, and a full Stryker run over a suite this
size costs more wall-clock than the phase gate it would sit in. The decision is revisited
when the analysis engine's suite is large enough that checking it by hand stops being
credible.

## Thresholds, and why each number is that number

No number here is a best practice borrowed from a book. Each is measured against this
repository, and each says what would move it.

| Threshold                      | Value    | Why this value                                                                                                                                                                                                                                                       | What would change it                                                                                             |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cyclomatic complexity, product | 15       | The most complex function in `platform/` today is 14 (`assertAgainstGrid`). 15 fails nothing now and blocks the next 30-branch function. A ratchet, not an ideal.                                                                                                    | Evidence that a function under 15 was still unreviewable, or that the limit forced a split that made code worse. |
| Cyclomatic complexity, harness | none     | `scripts/**` has functions at 61. Refactoring them is its own work with its own risk; imposing a limit now would either fail the build or be set so high it proves nothing.                                                                                          | The harness refactor filed in `BACKLOG.md`.                                                                      |
| Mutation score                 | none     | No mutation tool is installed. A target without a measurement is a number nobody can act on.                                                                                                                                                                         | Stryker landing.                                                                                                 |
| Typed-lint rule set            | 13 rules | Each was measured before it was enabled: 8 had zero violations, 5 had 13 between them, all fixed in the same commit. The full `recommended-type-checked` preset was not adopted, because rules that churn without catching defects make the gate expensive to trust. | A defect class getting through that a further rule would have caught.                                            |
| Full-tree lint duration        | ~11.5s   | Up from 2.5s. Paid on `pnpm gates`, not in the inner loop — pre-commit lints staged files only.                                                                                                                                                                      | If it reaches a point where people stop running it.                                                              |

One repository policy. Per-model or per-workflow thresholds are speculation until run data
says otherwise.

## Agentic maintainability

The property this document optimizes for, stated plainly:

> How much repository context, and how many repair loops, does an agent need in order to
> make one safe local change?

It is why `DESIGN-4` (narrow interface, deep implementation) and the module boundaries
matter more here than in a codebase read only by people. A module that forces three
unrelated concerns into the same context does not just read badly — it makes every packet
that touches it more expensive, and the cost is invisible in the diff.

**Currently observable**, per lane, from the existing telemetry and handoffs:
files changed, commands run, repair iterations (`.artifacts/telemetry/lanes.jsonl`,
`.artifacts/handoffs/`).

**Not observable yet**, and deliberately not invented: files read, modules traversed,
tokens consumed per change, dependency fan-out per packet. These are recorded here as
future metrics rather than estimated — a fabricated measurement is worse than none.

**Candidate future metric — Context Surface Ratio:** context required to make a change ÷
the surface the change actually touched. **Experimental.** It is not a quality truth, no
threshold attaches to it, and no gate reads it.

## Future backlog boundary

Five capabilities are named, scoped, and deliberately **not built**: an architecture
intelligence view (heatmap), an agentic maintainability score, delayed decision outcome
attribution, learned/adaptive engineering policies, and context lifecycle optimization.
Each one, with the evidence it would need and the run count that reopens it, is in
`BACKLOG.md` § _Provided as Engineering Standards §13 — Future Backlog (2026-08-20)_. They
are listed here only so the boundary below has something to point at; the ideas live there.

| ID    | Rule                                                                                                                                                                                                                             | Enforced by                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| FUT-1 | `[MUST]` No infrastructure exists solely for a future-backlog capability, and no current task expands to support one.                                                                                                            | Watchdog scope pass — telling preparation from speculation needs the packet's intent, which no script has. |
| FUT-2 | `[MUST]` No metric derived from these is presented as causal from a before/after comparison, and high token usage alone is never reported as bad architecture.                                                                   | Reviewer — the claim is in prose, not in a type.                                                           |
| FUT-3 | `[MUST]` No learned or adaptive policy weakens a security guarantee, a correctness contract, a data-integrity invariant, or an architecture boundary. Any policy change goes through the existing approval and escalation rules. | `CLAUDE.md` escalation triggers 2 and 4.                                                                   |
| FUT-4 | `[MUST]` No composite score ships before the raw evidence it is derived from is exposed on its own.                                                                                                                              | Reviewer, at the packet that would introduce the score.                                                    |
| FUT-5 | `[SHOULD]` Preserve evidence that is already cheap to keep, avoid decisions that needlessly block these capabilities, and record a missing prerequisite in `BACKLOG.md` when one is discovered.                                  | `update-backlog`.                                                                                          |

A heuristic written by hand is a heuristic. It becomes learned behaviour when runs say so,
and not before. The order is: instrument, observe, learn, productize.

## Adding or changing a standard

1. Walk the ladder. Stop at the first rung that can hold the rule.
2. If it lands on rung 6, write the reason a machine cannot hold it in the **Enforced by**
   column. A `[MUST]` with an empty enforcer does not get added.
3. Add it here, with an ID. Do not add it to `CLAUDE.md`, an agent prompt, or a skill —
   they cite this file.
4. If the rule is mechanical, land the check and the fix for existing violations in the
   same commit. A rule that is on but violated teaches everyone that gates are advisory.
5. Reflector proposes a new standard only after the same problem has recurred across at
   least two completed slices. One incident is an incident.
