<!-- refreshed: 2026-10-29 -->

# Architecture

**Analysis Date:** 2026-10-29

## System Overview

```text
External agents / playground mock agents
  -> telemetry-sdk -> HTTP telemetry API -> entity repositories -> PostgreSQL
                            |
Dashboard <- read API ------+
Dashboard -> explicit analysis API -> pure analysis-engine
                                  -> recommendation repository -> PostgreSQL
```

## Component Responsibilities

| Component              | Responsibility                                             | File                                                        |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Wire contract          | Runtime schemas and derived public types                   | `platform/shared/index.ts`, `platform/shared/read/index.ts` |
| SDK                    | Bounded asynchronous telemetry delivery and payload safety | `platform/telemetry-sdk/src/client.ts`                      |
| API composition        | Config, logs, persistence, ingestion, reads, analysis      | `platform/api/src/app.module.ts`                            |
| Ingestion              | Per-event validation, merge and persistence orchestration  | `platform/api/src/telemetry/telemetry.service.ts`           |
| Pure analysis          | Aggregation, gates and failed-action detection             | `platform/analysis-engine/src/index.ts`                     |
| Analysis orchestration | Load persisted records, evaluate, persist/withdraw claims  | `platform/api/src/analysis/analysis.service.ts`             |
| Database               | Client construction, schema and migrations                 | `platform/database/src/index.ts`                            |
| Dashboard              | Run explorer and recommendation interfaces                 | `platform/dashboard/src/app/`                               |
| Example producers      | Deterministic mock workflows and scenarios                 | `playground/agents/mock-agent.ts`, `playground/scenarios/`  |

## Pattern Overview

Modular Nest API with explicit persistence edges, pure analysis functions, schema-driven wire contracts, and an independent Next.js reader. The engineering harness under `scripts/` and `.claude/` is a separate development control plane (`CLAUDE.md`).

## Layers

- `platform/shared/schema/` owns telemetry/recommendation contracts; `platform/shared/read/` owns read models. Derive cross-process types from schemas.
- `platform/telemetry-sdk/src/` owns producer-side behavior. Its only platform import is shared; it must not gain Prisma transitively.
- `platform/api/src/<domain>/` separates controllers, services, repositories, and explicit record mappers. Keep Prisma-shaped rows at repository edges.
- `platform/analysis-engine/src/` exposes functions over plain records. Keep persistence, transport, rendering and framework concerns outside it.
- `platform/dashboard/src/lib/` handles API reads and transforms; `platform/dashboard/src/app/` owns routes/rendering.

## Data Flow

### Telemetry request path

1. Caller records through SDK handles and bounded client (`platform/telemetry-sdk/src/handles.ts`, `platform/telemetry-sdk/src/client.ts`).
2. HTTP transport sends envelope batches and retry-stable delivery identity (`platform/telemetry-sdk/src/transport.ts`).
3. Controller validates request structure, then service validates each event independently (`platform/api/src/telemetry/telemetry.controller.ts`, `platform/api/src/telemetry/telemetry.service.ts`).
4. Merge rules and repositories persist event state and replay bookkeeping (`platform/api/src/telemetry/merge-rules.ts`, `platform/api/src/telemetry/telemetry.repository.ts`).
5. Read API maps persisted state into shared read models (`platform/api/src/runs/runs.service.ts`).

### Analysis path

1. Explicit `POST /v1/analysis/run` invokes `platform/api/src/analysis/analysis.service.ts`.
2. Repository loads persisted decisions/tool calls; source mappers apply eligibility and stale rules (`platform/api/src/analysis/analysis.repository.ts`, `platform/api/src/analysis/analysis-source.ts`).
3. Engine aggregates decisions, evaluates all gates and detects failed-action streaks (`platform/analysis-engine/src/aggregate.ts`, `gates.ts`, `repeated-failed-action.ts`).
4. API maps findings to shared wire shapes, persists sightings or withdraws invalidated claims, and returns evaluated groups including suppression (`platform/api/src/analysis/evaluated-group.ts`, `platform/api/src/recommendations/recommendations.service.ts`).
5. Dashboard parses and renders the response (`platform/dashboard/src/lib/recommendations-api.ts`).

**State:** PostgreSQL is persisted truth. SDK buffers are bounded process-local state. Analysis performs explicit full-history recomputation; no background scheduler is registered in `platform/api/src/app.module.ts`.

## Key Abstractions

- Group identity is workflow name/version, decision type, and context-key version. `contextKey` is a diversity dimension within the group (`platform/analysis-engine/src/types.ts`, `aggregate.ts`).
- Attestation is a caller assertion, distinct from observed selection (`platform/shared/schema/decision-events.ts`, `platform/api/src/decisions/decision-attestation.ts`).
- Recommendations carry evidence and counterexamples; dedupe uses versioned analyzer identity and a unique fingerprint (`platform/api/src/recommendations/fingerprint.ts`, `platform/database/prisma/schema.prisma`).

## Entry Points

- API boot: `platform/api/src/main.ts`; `/v1` prefix except `/health`.
- Dashboard routes: `platform/dashboard/src/app/page.tsx`, `runs/page.tsx`, `runs/[id]/page.tsx`, `recommendations/page.tsx`.
- Public SDK: `platform/telemetry-sdk/src/index.ts`; pure analysis: `platform/analysis-engine/src/index.ts`.
- Scenario CLIs: `playground/cli/happy-path.ts`, `playground/scenarios/repeated-failure/main.ts`, `playground/scenarios/deterministic-decision/main.ts`.

## Architectural Constraints

- Platform must run with Playground removed; SDK imports only shared; Playground imports SDK public entry only (`.dependency-cruiser.cjs`, `scripts/check-isolation.ts`).
- Analysis never runs inline with ingestion. `TelemetryModule` has no analysis-module edge (`platform/api/src/app.module.ts`).
- No hidden chain-of-thought or counterfactual claim is licensed by telemetry (`MVP_PLAN_V3.md`, `CONTEXT.md`).
- Unknown/incomplete data must remain distinguishable from observed zero, success, or completed state (`platform/api/src/runs/stale.ts`, shared schemas).
- Database deliberately omits event-entity foreign keys to accept out-of-order arrivals (`platform/database/prisma/schema.prisma`). Do not add them without addressing that contract.

## Anti-Patterns

- Avoid coupling producers to API internals: use `@lengentic/telemetry-sdk` public entry, as `playground/agents/mock-agent.ts` does.
- Avoid reporting only emitted recommendations: preserve suppressed evaluated groups and every failing gate (`platform/api/src/analysis/analysis.service.ts`, `platform/shared/schema/recommendation.ts`).
- Avoid one API hostname for both browser and container SSR: use `resolveApiBaseUrl()` in `platform/dashboard/src/lib/api.ts`.

## Error Handling

- API uses global exception mapping and explicit parser configuration (`platform/api/src/common/all-exceptions.filter.ts`, `configure-body-parser.ts`).
- SDK transport uses delivered/retryable/permanent results rather than untyped thrown failure (`platform/telemetry-sdk/src/transport.ts`).
- Dashboard distinguishes unreachable, HTTP-error and invalid-contract results (`platform/dashboard/src/lib/recommendations-api.ts`).

## Cross-Cutting Concerns

- Logging: Pino with header redaction (`platform/api/src/app.module.ts`).
- Validation: Zod at HTTP and SDK contract edges; independent analysis-response parsing before return (`platform/api/src/analysis/analysis.service.ts`).
- Authentication: outside MVP scope; reflected-origin CORS configured in `platform/api/src/main.ts`.

_Architecture analysis: 2026-10-29; source presence is not phase acceptance evidence._
