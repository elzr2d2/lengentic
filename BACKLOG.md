# BACKLOG

Ideas that are valuable but not required by the current phase's Definition of Done
(`MVP_PLAN.md` §8). Nothing here may expand the active phase.

The standing post-MVP list lives in `MVP_PLAN.md` §94 and is not duplicated here. This
file records items **discovered during implementation**, with the discovery context that
makes them actionable later.

---

## Discovered during Phase 0 plan review (2026-08-14)

### Context-conditional defaults

**Source:** corrections doc §1.
The corrected group key aggregates across `contextKey`, which licenses the claim _"this
option wins across varied situations."_ A per-`contextKey` analyzer would license a
finer claim — _"in `post_refactor_large_diff`, always NO"_ — which is more actionable but
needs far more data per group and directly contradicts G2's purpose. A real v2 analyzer,
not an MVP variant of the existing one.

### Recommendation demotion on regression

**Source:** [Progressive Crystallization](https://arxiv.org/abs/2607.07052), §0 of the
corrections doc.
That system pairs promotion with a circuit-breaker that demotes a deterministic playbook
back to hybrid on execution failure or acceptance-test regression. LenGentic has an
`ACCEPTED` recommendation status and no mechanism to notice that an accepted default
stopped holding. Related to, and probably subsumed by, §94's **shadow mode**, which is the
honest version — it produces the counterfactual instead of inferring it.

### Weight counterexamples by attestation

**Source:** observed in fixture `D2`.
`D2` reports three counterexamples: one attested `SUCCESS` and two `UNKNOWN`. A dissent
whose outcome was never attested is weaker evidence than one known to have succeeded, and
the current output gives them equal visual weight. Options: sort attested-first, annotate
the count as "3 (1 attested)", or exclude `UNKNOWN` dissents from the concentration
calculation. Deliberately **not** decided in Phase 0 — it changes what the report claims,
and the fixtures should drive that decision rather than an aesthetic preference.

### Concentration output is noisy for wide minorities

**Source:** observed in fixture `D9`.
A 60/40 split across 11 contexts prints an 11-row concentration table for a group that
produced no recommendation. The rows are correct but carry no signal — a scattered
minority is a single finding ("the boundary is not context-shaped"), not eleven. Consider
collapsing to a scatter/concentration summary when no single context exceeds some share.

## Discovered during Phase 1 (2026-08-14)

### Slim the API runtime image

**Source:** `docker/api.Dockerfile`.
The runtime stage copies the whole built workspace, dev dependencies included, because
`pnpm deploy` needs `inject-workspace-packages=true` and that setting replaces local
symlinks with copies, which degrades the day-to-day dev loop. The dashboard image is
already lean via Next's `output: 'standalone'`. Revisit if image size becomes a real
constraint; it is not one for a local-only MVP.

### Upgrade to the next tooling majors

**Source:** pnpm reported newer majors during install.
ESLint 10, TypeScript 7, and dependency-cruiser 18 are all available. TypeScript 7 is the
Go port, and NestJS, Prisma, and typescript-eslint have not all landed support. Deferred
deliberately: a portfolio project that cannot build is worse than one on a
six-month-old compiler. Revisit once `typescript-eslint` ships a TS 7 parser.

### Teach Validator the mutation check

**Source:** §35 harness validation run with live agent dispatch (2026-08-15).

Validator correctly identified a false-positive test — `harness.controller.spec.ts` had
re-declared its own copy of the schema under test, so it stayed green while the endpoint
was broken. Validator then authored a replacement contract test that had **the same defect
in a different shape**: it drove `?a=1e308`, which the parameter regex rejects before the
code under test is reached, and its oracle was `if (status === 200) expect a number; else
expect 400` — an assertion satisfied by both branches of the behavior it was testing.
Deleting the guard it claimed to cover left all 19 tests green. Verified mechanically.

`.claude/agents/validator.md` already says "detect false-positive tests." That is the
_goal_, not a _method_, and the goal alone did not prevent Validator from writing one.
The concrete technique is a mutation check: **would this test still pass if the code under
test were deleted?** Also worth stating that an oracle accepting two different outcomes is
not pinning a contract.

Deferred because §36 asks that agent responsibilities be _defined_, and they are. This
sharpens how well one of them is discharged, which is a real improvement and not a
Definition-of-Done item. Do not fix by adding a rule to every agent file — it belongs to
the role that writes tests.

### Rename `zodBody` — it is used at `@Query` sites too

**Source:** Reviewer finding, §35 harness validation run (2026-08-15).

`platform/api/src/common/zod-validation.pipe.ts:36` exports `zodBody`, and its docstring
says controllers should read as `@Body(zodBody(EventBatchSchema))`. The disposable §35
endpoint used it at a `@Query` site, where it works correctly but the name is a lie.

This is permanent Phase 1 code and Phase 2's ingestion controllers will copy whatever
precedent it sets. Options: rename to `zodPipe`, or keep `zodBody` and add a `zodQuery`
alias so the call site reads honestly. Not urgent — nothing is wrong at runtime — but it
gets more expensive to change once §41's ingestion endpoints exist.

---

## Environment prerequisites (not backlog — blocking)

- ~~**Node.js v21.0.0**~~ — resolved 2026-08-14. Node 24.19.0 LTS and pnpm 11.21.0 are
  installed and the whole toolchain runs on them.

- **Docker is not installed, and neither is WSL2.** This blocks four `MVP_PLAN.md` §36
  checkboxes — "PostgreSQL starts", "API reaches PostgreSQL", "`docker compose up`
  succeeds" — plus `pnpm test:integration`, since Testcontainers needs a daemon.

  Docker Desktop on Windows requires WSL2 or Hyper-V, so this is an elevated install plus
  a reboot, not a package fetch:

  ```
  wsl --install
  winget install Docker.DockerDesktop
  ```

  Everything else in Phase 1 is verified. `docker-compose.yml` and both Dockerfiles are
  written but **have never been executed** — treat them as unreviewed until
  `docker compose up` runs once.
