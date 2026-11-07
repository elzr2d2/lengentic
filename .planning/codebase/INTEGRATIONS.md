# External Integrations

**Analysis Date:** 2026-10-29

## APIs & External Services

- Telemetry producers call the LenGentic API through `platform/telemetry-sdk/src/transport.ts`.
- Ingestion endpoint: `POST /v1/telemetry/events`, owned by `platform/api/src/telemetry/telemetry.controller.ts`.
- Dashboard consumes its own API, with runtime contract validation for runs and recommendations: `platform/dashboard/src/lib/runs-api.ts`, `platform/dashboard/src/lib/recommendations-api.ts`.
- No external model-provider service is required by the inspected runtime. Example producers use `playground/providers/mock-provider.ts`; observed model calls are telemetry, not a requirement for LenGentic to invoke models.

## Data Storage

**Database:** PostgreSQL via Prisma 7 and `@prisma/adapter-pg`.

- Connection variable: `DATABASE_URL`, validated in `platform/api/src/config/env.schema.ts`.
- Client factory: `platform/database/src/index.ts`.
- Nest lifecycle ownership: `platform/api/src/prisma/prisma.service.ts`.
- Schema and migrations: `platform/database/prisma/schema.prisma`, `platform/database/prisma/migrations/`.
- Models cover Run, Step, Decision, ModelCall, ToolCall, Error, ingestion/drop replay bookkeeping, and Recommendation.

**File storage:** No application object-storage integration detected in inspected platform entry points.

**Caching:** No Redis dependency. `platform/api/src/analysis/analysis.service.ts` explicitly describes on-demand analysis without queue, worker service, or job table.

## Authentication & Identity

- Authentication is explicitly outside MVP scope in `platform/api/src/main.ts`.
- CORS currently allows reflected origins (`origin: true`); there is no credentialed CORS configuration there.
- Recommendation fingerprints are application deduplication identities, not authentication: `platform/api/src/recommendations/fingerprint.ts`.

## Monitoring & Observability

- Pino request logging with credential-bearing header redaction: `platform/api/src/app.module.ts`.
- Health endpoint `/health` reports service/database health: `platform/api/src/health/health.controller.ts`, `platform/api/src/health/health.service.ts`.
- No external error tracking provider detected in inspected manifests.

## CI/CD & Deployment

- GitHub Actions: `.github/workflows/ci.yml`, on main pushes and pull requests.
- CI runs lint, formatting, types, tests, build, boundaries, harness selftests and isolation; integration has a separate job.
- Container deployment files: `docker/api.Dockerfile`, `docker/dashboard.Dockerfile`, `docker-compose.yml`. A production cloud deployment is not established by their existence.

## Environment Configuration

- API: `DATABASE_URL`, `NODE_ENV`, `API_PORT`, `LOG_LEVEL`, `STALE_RUN_THRESHOLD_MS` (`platform/api/src/config/env.schema.ts`).
- Dashboard: `NEXT_PUBLIC_API_BASE_URL`, `API_BASE_URL_INTERNAL` (`platform/dashboard/src/lib/api.ts`). The latter avoids container-local loopback errors during server rendering.
- SDK: callers pass endpoint and transport configuration; see `platform/telemetry-sdk/src/config.ts`, `platform/telemetry-sdk/src/transport.ts`.
- `.env` files exist. Do not copy secret values into knowledge-base documents.

## Webhooks & Callbacks

- Incoming: telemetry HTTP ingestion above; explicit analysis trigger `POST /v1/analysis/run` in `platform/api/src/analysis/analysis.controller.ts`.
- Outgoing: no third-party webhook delivery integration detected. SDK HTTP transport is the outgoing producer-to-platform path.

_Integration audit: 2026-10-29; static source inspection._
