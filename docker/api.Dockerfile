# syntax=docker/dockerfile:1.7
#
# Build context is the repository root, not this directory — a pnpm workspace build needs
# the root lockfile and workspace manifest.
#
#   docker build -f docker/api.Dockerfile .

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app


FROM base AS build

# Manifests first, source second. Source changes are frequent and dependency changes are
# not, so this ordering keeps the install layer cached across ordinary edits.
#
# `.husky/` is copied here too: the root `prepare` lifecycle script runs on `pnpm install`
# and requires `.husky/prepare.mjs` to exist, even though there is no `.git` in the image for
# it to wire up (the script no-ops in that case — see its own guard). Without the file present
# at all, `pnpm install` dies on MODULE_NOT_FOUND before it installs anything.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY .husky ./.husky
COPY platform/api/package.json ./platform/api/
COPY platform/database/package.json ./platform/database/

# `@lengentic/api...` resolves the package plus its workspace dependencies, so the
# dashboard's Next and React never enter this image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@lengentic/api..."

COPY platform/database ./platform/database
COPY platform/api ./platform/api

# The database package must build first — it generates the Prisma client the API imports.
#
# `prisma.config.ts` resolves DATABASE_URL when the config loads, and `.dockerignore` keeps
# .env out of the build context on purpose. `prisma generate` reads the schema and never
# opens a connection, so a syntactically valid placeholder is enough. It is set on the RUN
# rather than as ENV so it stays out of the image metadata and cannot be mistaken at runtime
# for a real target — compose supplies the real URL to the runtime stage.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public" \
    pnpm --filter @lengentic/database build \
 && pnpm --filter @lengentic/api build


FROM base AS runtime
ENV NODE_ENV=production

# Node images ship a `node` user. Running as root inside a container that accepts other
# systems' telemetry payloads is an unnecessary blast radius.
COPY --from=build --chown=node:node /app /app
USER node

WORKDIR /app/platform/api
EXPOSE 3001

# `docker compose` polls /health, which returns 503 when the database is unreachable, so
# an API that starts before Postgres is ready reports unhealthy rather than healthy-but-broken.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
