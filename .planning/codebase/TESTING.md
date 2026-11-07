# Testing Patterns

**Analysis Date:** 2026-10-29

## Verification scope

This document records static inspection of tests, manifests, and CI. No unit, integration, browser, or full gate suite was executed for this mapping. Existing tests and configured CI do not establish a fresh passing result.

## Test Framework

- Vitest; `platform/analysis-engine/package.json` declares `^4.1.10`.
- Standard assertions and doubles use `expect` and `vi` from Vitest.
- API unit configuration: `platform/api/vitest.config.mts`; Node environment and SWC transform preserve Nest decorator metadata.
- API integration configuration: `platform/api/vitest.integration.config.mts`; separate Docker-dependent suite, 60-second test and 180-second hook timeouts, `fileParallelism: false`.
- Dashboard configuration: `platform/dashboard/vitest.config.mts`; Node environment, `@` alias, automatic JSX transform. Async server pages are rendered without a DOM.

```sh
pnpm test
pnpm --filter @lengentic/api test <path-substring>
pnpm --filter @lengentic/analysis-engine test:watch
pnpm test:integration
pnpm gates
pnpm gates:full
```

The root `test` builds the database client before recursive package tests: `package.json`. Integration is separate from `pnpm gates` and requires Docker. No repository-wide coverage percentage threshold was established by this review.

## Test File Organization

- API unit tests colocate as `platform/api/src/<feature>/*.spec.ts`.
- API integration tests live under `platform/api/test/**/*.integration.spec.ts`.
- Library tests live under `platform/shared/test/`, `platform/telemetry-sdk/test/`, and `platform/analysis-engine/test/`.
- Dashboard feature tests colocate under `platform/dashboard/src/`; package harness tests live in `platform/dashboard/test/`.
- Engineering harness uses executable selftests: `scripts/kb/selftest.ts`, `scripts/flow/selftest.ts`, `scripts/lanes/selftest.ts`, and `scripts/autopilot/selftest.ts`.

## Test Structure

Use behavior-oriented `describe`/`it` suites. Example from `platform/telemetry-sdk/test/determinism.spec.ts`:

```ts
const first = await runScenario(1_234);
const second = await runScenario(1_234);
expect(first.transport.allEvents.length).toBeGreaterThan(0);
expect(second.transport.allEvents).toEqual(first.transport.allEvents);
```

The nonempty assertion prevents two empty outputs from creating a false positive. `CONTEXT.md` calls this defense against a “green that lies.” Expectations must be independent of the operation producing the actual result.

## Mocking

- SDK: inject `RecordingTransport` and `FakeScheduler`, with seeded time/IDs; see `platform/telemetry-sdk/test/support/` and `test/determinism.spec.ts`.
- Dashboard pages: stub HTTP `fetch`, then execute the real page and reader. Do not mock the reader itself: `platform/dashboard/src/app/runs/runs-pages.spec.ts` and `recommendations/recommendations-page.spec.ts`.
- Restore global and environment stubs after each test. Address-resolution cases reset modules because environment is read on import: `platform/dashboard/test/harness.spec.ts`.
- Database behavior needs real Postgres integration, not only mocked repositories: `platform/api/test/telemetry.integration.spec.ts`, `analysis.integration.spec.ts`.

## Fixtures and Factories

Analysis fixture inputs and expectations are separate from analyzer implementation. `platform/analysis-engine/test/analyzer/deterministic-candidate.spec.ts` supplies actual results to `test/grid/assert-against-grid.ts`. It checks twelve D-grid rows (D8 splits by workflow version) and fifteen boundary rows.

Use the authoritative grid in `MVP_PLAN_V3.md` Phase 5, not `spike/` expectations. Negative cases, all independently failing gates, counterexamples, and threshold binding have dedicated files under `platform/analysis-engine/test/`.

## Test Types

- Pure behavior: aggregation, gate evaluation, repeated-failure detection, fingerprinting, SDK bounded queues, payload safety, and run summary helpers; see analyzer, SDK, and API `*.spec.ts` files.
- HTTP/module behavior: controller/module tests under `platform/api/src/`.
- Database integration: Testcontainers/Postgres suites under `platform/api/test/`, including out-of-order telemetry and stale-on-kill child processes.
- Rendered dashboard behavior: server component markup through actual parsing/fetch paths in dashboard page specs.
- Browser automation: no Playwright or Cypress file was detected by filename scan. Rendered server-page tests do not prove real browser navigation or interaction.

## CI and gates

`.github/workflows/ci.yml` defines separate quality, integration, and Docker jobs. Quality runs lint, formatting, typecheck, tests, build, boundaries, harness scenarios, and isolation. Integration runs `pnpm test:integration`. Docker builds API/dashboard images and starts Compose with health/HTTP smoke checks.

`pnpm gates` additionally contains `pnpm check:integrity` (`package.json`). No explicit `check:integrity` invocation appears in the inspected CI workflow; see `CONCERNS.md`.

`scripts/check-integrity.ts` scans focused/skipped tests and other false-green patterns. Harness selftests remain outside product gates by design. `.husky/pre-commit` delegates staged checks to `scripts/precommit.ts`.

## Roadmap acceptance

`MVP_PLAN_V3.md` Phase 7 requires four end-to-end outcomes: complete ingestion-to-dashboard flow, repeated-failure recommendation, deterministic candidate with counterexamples, and batch-iteration silence. It also requires clean-clone demo evidence at `.artifacts/evidence/7/demo-rehearsal.md`. Do not replace per-criterion evidence with a count of passing unit tests.

_Testing analysis: 2026-10-29_
