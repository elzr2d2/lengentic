# Technology Stack

**Analysis Date:** 2026-10-29

## Languages

- TypeScript ^5.9.2 throughout `platform/` and `playground/`; TSX in `platform/dashboard/src/app/`.
- SQL migrations in `platform/database/prisma/migrations/`; JavaScript configuration and build helpers at the root and `platform/database/scripts/`.
- `tsconfig.base.json` targets ES2023 and enables strict mode, unchecked indexed access, exact optional properties, and unknown catch variables.

## Runtime

- Node >=22.13; pnpm >=10 required by `package.json`.
- Package manager pinned to pnpm 11.21.0 in `package.json`; `pnpm-lock.yaml` is present.
- Workspace definitions: `pnpm-workspace.yaml`. Runtime services: API and dashboard; PostgreSQL is the persistence dependency.

## Frameworks

| Framework                     | Manifest range | Use / source                                                         |
| ----------------------------- | -------------- | -------------------------------------------------------------------- |
| NestJS                        | ^11.2.1        | HTTP API; `platform/api/package.json`                                |
| Next.js                       | ^16.3.1        | App Router dashboard; `platform/dashboard/package.json`              |
| React / React DOM             | ^19.2.8        | Dashboard rendering; `platform/dashboard/package.json`               |
| Prisma and PostgreSQL adapter | ^7.9.1         | Persistence; `platform/database/package.json`                        |
| Zod                           | ^4.4.3         | Runtime wire contracts; `platform/shared/package.json`               |
| Vitest                        | ^4.1.10        | Platform package tests; package manifests                            |
| Testcontainers                | ^12.1.0        | Disposable PostgreSQL integration tests; `platform/api/package.json` |

Versions above are declared ranges, not a claim about the installed dependency graph.

## Key Dependencies

- `nestjs-pino`, `pino`, and `pino-http`: structured request logging in `platform/api/src/app.module.ts`.
- `@prisma/adapter-pg`: explicit PostgreSQL driver adapter in `platform/database/src/index.ts`.
- SDK runtime platform dependency is only `@lengentic/shared`: `platform/telemetry-sdk/package.json`.
- Analysis engine has no declared runtime dependency: `platform/analysis-engine/package.json`.

## Configuration

- Environment validation: `platform/api/src/config/env.schema.ts`; required `DATABASE_URL`, optional/defaulted `NODE_ENV`, `API_PORT`, `LOG_LEVEL`, `STALE_RUN_THRESHOLD_MS`.
- Dashboard addresses: `NEXT_PUBLIC_API_BASE_URL` at build time; `API_BASE_URL_INTERNAL` for server-side calls at runtime. See `platform/dashboard/src/lib/api.ts`.
- `.env` and `.env.example` exist; their contents were not inspected.
- Build: `platform/api/nest-cli.json`, package `tsconfig.build.json` files, `platform/dashboard/next.config.ts`, and `platform/database/scripts/build-if-changed.mjs`.

## Platform Requirements

- Development: Node/pnpm; Docker for PostgreSQL and integration tests. See `README.md` and `.github/workflows/ci.yml`.
- Container definitions: `docker/api.Dockerfile`, `docker/dashboard.Dockerfile`, `docker-compose.yml`.
- Local service conventions: dashboard 3000, API 3001, PostgreSQL 5432 (`README.md`). No managed cloud hosting target established by these files.
- The SDK is intended as the public artifact, but its current manifest is private (`platform/telemetry-sdk/package.json`); do not infer npm publication.

_Stack analysis: 2026-10-29; static source inspection, no runtime validation._
