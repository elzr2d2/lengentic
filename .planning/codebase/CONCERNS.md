# Codebase Concerns

**Analysis Date:** 2026-10-29

## Evidence scope

Static review only. These findings identify inspectable risks and roadmap verification needs, not reproduced runtime failures. No fresh test results or phase-completion claims are made here. `MVP_PLAN_V3.md` remains authoritative; `BACKLOG.md` owns deferred scope.

## Tech Debt

**CI does not explicitly run the product integrity gate:**

- Files: `.github/workflows/ci.yml`, `package.json`, `scripts/check-integrity.ts`.
- Evidence: root `gates` includes `check:integrity`; CI expands individual quality commands but contains no `check:integrity` invocation.
- Impact: focused/skipped-test and other integrity regressions may escape that CI job despite local gates catching them.
- Fix approach: add the integrity command to CI as an explicit independent step, then validate its failure behavior. This map does not modify CI.

**Harness complexity has a separate maintenance burden:**

- Files: `eslint.config.js`, `scripts/lanes.ts`, `scripts/flow.ts`, `scripts/autopilot.ts`.
- Evidence: product code has a complexity ceiling of 15; scripts are explicitly exempt, with debt directed to `BACKLOG.md`.
- Impact: orchestration changes require their own selftests and can invalidate phase-status evidence independently of runtime correctness.
- Safe change: preserve product/harness separation and run affected `check:lanes`, `check:flow`, or `check:autopilot` scenarios.

## Known Bugs

No new runtime bug was reproduced. Historical bug descriptions in comments are not treated as current defects; for example internal dashboard API address resolution is covered by `platform/dashboard/test/harness.spec.ts`.

## Security Considerations

**MVP has no authentication boundary:**

- Files: `platform/api/src/main.ts`, `MVP_PLAN_V3.md` section 26.
- Evidence: API enables CORS with `origin: true`; its comment explicitly places authentication outside MVP scope.
- Risk: telemetry/read/analysis surfaces need an access boundary before exposure beyond the intended demo/development environment.
- Current mitigation: schema/body limits and safe client errors exist; they are not caller authentication. See `platform/api/src/common/configure-body-parser.ts` and `all-exceptions.filter.ts`.
- Scope: production access control is a future scope decision, not a reason to silently expand this roadmap.

## Performance Bottlenecks

**Analysis recomputes full history in API memory:**

- Files: `platform/api/src/analysis/analysis.repository.ts`, `analysis.service.ts`.
- Evidence: unbounded `decision.findMany`, a second Run query using all run IDs, and unbounded ToolCall reads. Service executes explicitly on demand.
- Impact: memory/query/response time grows with history; large run-ID lists add database query pressure.
- Current mitigation: narrow column projections exclude large raw-context/tool-IO payloads; deterministic ordering makes repeated evaluations reproducible.
- Improvement path: benchmark representative history first; incremental processing or jobs would change the explicit full-recomputation contract in `MVP_PLAN_V3.md` section 22 and require an architecture decision.

## Fragile Areas

**Gate mathematics and evidence ownership:**

- Files: `platform/analysis-engine/test/grid/`, `platform/analysis-engine/fixtures/`, `MVP_PLAN_V3.md` sections 18â€“20 and Phase 5.
- Why fragile: eligible versus attested denominators, diversity, version splits, and minority counterexamples determine whether a recommendation is safe.
- Safe modification: keep expected grid values independent of analyzer output; run threshold-binding and negative fixture tests. Do not use the historical spike as the current oracle.

**Delayed/out-of-order event persistence:**

- Files: `platform/api/src/telemetry/telemetry.repository.ts`, `merge-rules.spec.ts`, `platform/api/test/telemetry.integration.spec.ts`.
- Why fragile: entities can precede their parents and terminal-state conflicts have explicit merge rules.
- Safe modification: pair repository unit checks with real Postgres integration; schema constraints and locks cannot be proved by mocks alone.

## Scaling Limits

No production throughput, retention, or concurrent-user capacity was established by this mapping. SDK bounded queues are observable and intentional (`platform/telemetry-sdk/test/bounded-queue.spec.ts`, `drop-reporting.spec.ts`); they bound client memory by dropping data rather than promising lossless ingestion. Analysis capacity is bounded by process/database resources, not a documented benchmark.

## Dependencies at Risk

No external vulnerability or lifecycle audit was performed. Installed Next APIs require local version-specific guidance before dashboard edits (`platform/dashboard/AGENTS.md`). Dependency declarations alone do not establish production safety.

## Missing Critical Features and Test Coverage Gaps

**Roadmap end-to-end acceptance needs separate evidence:**

- Files: `MVP_PLAN_V3.md` Phase 7, `.github/workflows/ci.yml`, `platform/dashboard/src/app/runs/runs-pages.spec.ts`.
- Gap: static discovery found server-rendered page tests and Compose smoke coverage; neither alone proves all four end-to-end outcomes or the complete clean-clone demo.
- Priority: confirm per-beat demo and per-E2E acceptance records when assessing Phase 7. Do not infer â€œmissing implementationâ€ solely from absent browser-test filenames.

**No fresh gate evidence in this map:**

- Files: `package.json`, `.github/workflows/ci.yml`.
- Gap: this documentation task did not run runtime gates, Docker integrations, or demo rehearsal.
- Priority: use fresh command output and oracle/flow status for release or phase decisions; treat these documents as navigation and static analysis.

_Concerns audit: 2026-10-29_
