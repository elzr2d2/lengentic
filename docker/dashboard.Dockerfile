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

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY platform/dashboard/package.json ./platform/dashboard/

# Hoisted, and configured rather than passed as a flag.
#
# pnpm's default isolated layout puts every package behind a symlink in node_modules/.pnpm.
# Next's standalone tracer records those symlinked paths without copying everything they
# point at — `@swc/helpers`, which next/dist/server/require-hook.js resolves at runtime
# rather than statically, is dropped, and the container restart-loops on MODULE_NOT_FOUND.
# A flat node_modules removes the indirection the tracer mishandles.
#
# It has to be config, not `pnpm install --node-linker=hoisted`. pnpm 11 verifies dependency
# state before running any script, and a flag leaves that verification still expecting the
# isolated layout: it reported the hoisted tree as "installed by a different package manager"
# and silently re-installed the whole workspace (`+179 -593`) before `next build` started,
# restoring the symlink farm and reintroducing the crash. The verification is also what
# dragged root devDependencies into this stage, defeating the filtered install above.
ENV NPM_CONFIG_NODE_LINKER=hoisted
ENV NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@lengentic/dashboard..."

COPY platform/dashboard ./platform/dashboard

# NEXT_PUBLIC_ values are inlined at build time, not read at runtime. The default is the
# host-reachable address because this URL is resolved by the browser, not by the container
# — pointing it at `http://api:3001` would work inside the compose network and fail in
# every browser that loads the page.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN pnpm --filter @lengentic/dashboard build


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
