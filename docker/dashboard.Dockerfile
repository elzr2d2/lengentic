# syntax=docker/dockerfile:1.7
#
# Build context is the repository root.
#
#   docker build -f docker/dashboard.Dockerfile .

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app


FROM base AS build

# `.husky/` is copied alongside the manifests: the root `prepare` lifecycle script runs on
# `pnpm install` and requires `.husky/prepare.mjs` to exist, even though there is no `.git` in
# the image for it to wire up (the script no-ops in that case — see its own guard). Without
# the file present at all, `pnpm install` dies on MODULE_NOT_FOUND before it installs anything.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY .husky ./.husky
COPY platform/shared/package.json ./platform/shared/
COPY platform/dashboard/package.json ./platform/dashboard/

# Hoisted node_modules, inside the image only.
#
# `@swc/helpers` declares `module-sync` first in its exports map. Node 24 honours that
# condition from `require()` and resolves the subpath to `esm/_interop_require_default.js`,
# but Next's file tracer takes the `default` target and records `cjs/_interop_require_default.cjs`
# instead. Under pnpm's default isolated layout that is all the tracer records, so
# `.next/standalone` ships the package without its `esm/` directory and the container
# restart-loops on MODULE_NOT_FOUND the moment next/dist/server/require-hook.js runs. Under a
# flat layout the tracer records both variants and the standalone output boots.
#
# `--config.node-linker` is the channel that works. pnpm 11 does not read `node-linker` from
# NPM_CONFIG_*, and does not read it from .npmrc either; the only alternative is `nodeLinker`
# in pnpm-workspace.yaml, which would impose a flat layout on every developer and CI job to
# fix a problem that exists only in this image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.node-linker=hoisted --filter "@lengentic/dashboard..."

# `@lengentic/shared` is a build-time dependency of the dashboard, not just a type-only one:
# `src/lib/runs-api.ts` imports `@lengentic/shared/read`, whose `exports` resolve only into
# `platform/shared/dist/**`. `.dockerignore` excludes `**/dist`, so the directory is absent
# from the context and has to be produced inside the image before `next build` traces it.
COPY platform/shared ./platform/shared
COPY platform/dashboard ./platform/dashboard

# NEXT_PUBLIC_ values are inlined at build time, not read at runtime. The default is the
# host-reachable address because this URL is resolved by the browser, not by the container
# — pointing it at `http://api:3001` would work inside the compose network and fail in
# every browser that loads the page.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

# The linker has to be declared here too. pnpm verifies dependency state before running a
# script, and a build command that omits it evaluates the hoisted tree against isolated
# expectations, reports it as "installed by a different package manager" and silently
# re-installs the whole workspace before `next build` starts — restoring the symlink farm
# and the crash with it.
RUN pnpm --config.node-linker=hoisted --filter @lengentic/shared build \
 && pnpm --config.node-linker=hoisted --filter @lengentic/dashboard build


FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `output: 'standalone'` emits a self-contained server with only the modules it actually
# traced, so the runtime image carries no pnpm store and no dev dependencies.
COPY --from=build --chown=node:node /app/platform/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/platform/dashboard/.next/static ./platform/dashboard/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "platform/dashboard/server.js"]
