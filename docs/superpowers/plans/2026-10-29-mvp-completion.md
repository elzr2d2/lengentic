# MVP Completion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. Execute sequentially and retrieve each oracle packet before editing.

**Goal:** Close Phase 7 with reproducible evidence for every MVP acceptance criterion.

**Architecture:** Preserve the implemented platform and public SDK boundaries. Extend existing regression and integration tests; add actual dashboard journey coverage where current assertions stop at the API.

**Tech Stack:** TypeScript, pnpm, Vitest, NestJS, PostgreSQL, Next.js, Docker.

**Spec:** `MVP_PLAN_V3.md`, Phase 7 and sections 2, 24, 25. This document is an execution aid, not a replacement authority.

## Global constraints

- Follow `CLAUDE.md`, `docs/ENGINEERING_STANDARDS.md`, and packet `allowed_paths`; read dashboard `AGENTS.md` before changing dashboard files.
- Platform never imports Playground. Playground uses the SDK public entry.
- Say “attested success rate”; recommendations include `counterexamples`, even when empty.
- Freeze MVP scope. No new recommendation types, demotion feature, architecture refactor, or harness redesign.
- Presence probes and ignored marker files do not establish correctness.

## Current evidence

On 2026-10-29, `pnpm oracle status` and `pnpm flow next` exited 0. Phases 1–6 report complete presence probes; Phase 7 reports 1/5. Flow returns DISPATCH for E2E, README, regression, sequentially. No product suites were run while preparing this plan.

`pnpm gates:full` runs quality gates and isolation, not integration or E2E. CI already has integration and Docker jobs; it lacks an explicit integrity check and identifiable four-flow E2E coverage.

## Review focus

- Empty ingestion falsely passes silence: assert nonzero persisted workload before asserting zero recommendations (task 2).
- Prior runs contaminate results: isolate fixtures and scope assertions by run/cohort (task 2).
- Warm build artifacts conceal setup failures: test fresh installation (tasks 4–5).
- API success conceals dashboard failure: inspect rendered journey and navigation (tasks 2 and 5).
- A marker outlives the code it validated: record commit, commands, exit codes, expected/actual outcomes (all tasks).

## Execution steps

1. **Establish a bounded baseline.**
   - [ ] Capture `git status --short`, `git rev-parse HEAD`, `pnpm flow next`, and `pnpm oracle status`; preserve existing changes.
   - [ ] Confirm Node/pnpm versions, `docker info`, and availability of required environment variables without printing secrets.
   - [ ] Run `pnpm gates` once and capture logs under `.artifacts/evidence/7/`. Classify failures as product, test, or environment before editing.
   - [ ] Retrieve `pnpm oracle packet p7.e2e`. Follow packet ownership and handoff schema; do not change files outside allowed paths without resolving ownership.

2. **Close the E2E dependency first (`p7.e2e`).**
   - Files: extend `platform/api/test/**/*.integration.spec.ts` and existing integration setup; dashboard journey coverage must follow its packet ownership. Inspect existing tests before choosing new filenames or adding a browser dependency.
   - [ ] Map each flow to a named test and identify the first untested seam. Reuse existing setup and fixtures.
   - [ ] E2E 1: real Playground → public SDK → ingestion → PostgreSQL → dashboard; assert nonempty persisted events, visible run/detail data, and no happy-path recommendation after analysis.
   - [ ] E2E 2: repeated failures produce `REPEATED_FAILED_ACTION` through persisted analysis results.
   - [ ] E2E 3: deterministic-decision workload produces `DETERMINISTIC_CANDIDATE`, with persisted counterexamples visible in the dashboard.
   - [ ] E2E 4: batch iteration persists a nonempty evaluated group, fails G2, and produces no recommendation for that group.
   - [ ] For missing behavior, first run a failing assertion, implement the smallest repair, then rerun that test. Do not mock ingestion, persistence, or analysis in these integrated flows.
   - [ ] Run `pnpm test:integration`; document and run any separate dashboard E2E command introduced by this packet. Do not claim server-rendered markup tests prove browser interaction.
   - [ ] Record per-flow expected/actual/result and command exits; create the packet marker only after real success. Complete its required handoff and commit only intended files.

3. **Close regression and README packets, sequentially.**
   - Files: existing tests in `platform/analysis-engine/test/`, `platform/telemetry-sdk/test/`, API source specs and integration tests; `README.md`.
   - [ ] Retrieve `p7.regression`; create a 12-row checklist matching Phase 7’s critical unit-test list exactly. Link each row to test name, command, and result.
   - [ ] Cover detection, iteration discrimination, aggregation, individual gates, counterexamples, minority-context concentration, fingerprint/dedupe, lifecycle transitions, SDK overflow/drop counts, never-throw, redaction/truncation, and ingestion merge conflicts/out-of-order events.
   - [ ] Add only missing behavioral assertions; run focused tests during repairs, then `pnpm test` and any affected integration tests. Preserve negative-first analyzer fixtures.
   - [ ] Retrieve `p7.readme`; lead README with G2/prior art, copy section 2’s epistemic position verbatim, name absent demotion, use “attested success rate,” remove Phase-1 banner, and document all eight section-25 demo beats.
   - [ ] Verify commands against actual scripts; format changed Markdown. Record handoffs and separate packet commits.

4. **Close CI (`p7.ci-full`).**
   - Files: `.github/workflows/ci.yml`; package scripts only if required and allowed by the packet.
   - [ ] Retrieve packet after E2E completion. Wire the actual E2E command from task 2 into CI; if integrated into `test:integration`, make the four named flows visible in reports.
   - [ ] Add `pnpm check:integrity`; retain lint, formatting, types, boundaries, isolation, unit/integration tests, all package builds, and Docker validation.
   - [ ] Use frozen-lockfile installation and self-contained setup. Upload failure logs and test reports; ensure cleanup always runs for resources created by the job.
   - [ ] Run `pnpm gates:full`, `pnpm test:integration`, and any separate E2E command. Obtain a green actual CI run for the final implementation commit; record its URL and commit. If remote execution is unavailable, mark CI unverified rather than complete.

5. **Rehearse and close once.**
   - [ ] In a disposable clean checkout with isolated Docker resources, follow README without manual repairs. Do not delete the user's existing database volumes.
   - [ ] Record all eight demo beats in `.artifacts/evidence/7/demo-rehearsal.md`: startup, deterministic scenario, Runs, Run detail tabs, explicit analysis, Decision History, recommendation/counterexamples, suppressed G2 group.
   - [ ] Inspect the dashboard in a browser. Record actual cohort counts; do not force illustrative specification counts into observed evidence.
   - [ ] If any step needs repair, fix the owning packet and rerun affected validation. Historical docker-smoke evidence alone cannot validate the final checkout.
   - [ ] Complete required validation/handoffs; run `pnpm flow next` and follow its phase-gate action. Refresh `.planning/codebase/ROADMAP.md` with evidence references and remaining limitations.
   - [ ] Stop when all six Phase-7 DoD items pass on the final code, actual CI is green, and the demo needs no manual repair. Do not open another polish cycle.
   - **Recovery rule:** One reproduced failure, one stated hypothesis, one targeted repair. After two distinct failed recovery attempts for a gate, stop that work and report exact command, error, attempts, and smallest required decision, as required by `CLAUDE.md`. Do not retry unchanged commands indefinitely or weaken assertions to obtain green.
   - **Resume rule:** At session end record current packet, commit, failing command, completed criteria, and exact next command. Resume there instead of remapping the repository.
   - **Unresolved questions:** None for planning. Browser runner choice and missing regression assertions must be decided from existing packet/setup inspection during execution; they are not reasons to restart project design.
