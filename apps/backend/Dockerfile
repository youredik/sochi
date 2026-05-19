# =============================================================================
# Sochi backend — Node 24 Alpine + pnpm deploy (Q2 2026 canon, May 19 2026)
# =============================================================================
#
# Pattern verified against stankoff-v2 (proven в production). Native modules
# (sharp 0.35) работают через npm install regular flow. Bun --compile attempt
# (Dockerfile.distroless) failed empirically — Bun's bundler не copies .node
# files. This Dockerfile abandons --compile в favor of source + Node runtime.
#
# Backend uses `@hono/node-server` (runtime-agnostic) — works on Node 24+
# с native TypeScript stripping (since Node 22.6, stable 23.6).
#
# Alpine choice: 6 CVEs vs Debian slim 27 (stankoff finding 2026-04). YC
# Serverless Container accepts any image — no glibc requirement.

# --- Stage 1: Workspace + deps ---
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY . /app
WORKDIR /app

# --- Stage 2: Install + build shared + widget-embed ---
FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @horeca/backend... \
      --filter @horeca/shared... \
      --filter @horeca/widget-embed...

# Build shared package — Node не strips types в node_modules
RUN pnpm --filter @horeca/shared build

# Build widget-embed JS bundles (embed.js + booking-flow.js).
# Backend embed.factory.ts reads these from /widget-embed/dist/ at runtime
# (resolved via __dirname/../../../../widget-embed/dist after flat pnpm deploy).
RUN pnpm --filter @horeca/widget-embed build

# Apply publishConfig.exports — pnpm deploy --legacy doesn't auto-apply
RUN node -e " \
  const fs = require('fs'); \
  const pkgPath = 'packages/shared/package.json'; \
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); \
  if (pkg.publishConfig) { \
    Object.assign(pkg, pkg.publishConfig); \
    delete pkg.publishConfig; \
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)); \
  }"

# pnpm deploy: standalone directory с production-only deps
RUN pnpm --filter @horeca/backend --prod deploy --legacy /prod/backend

# --- Stage 3: Production runtime ---
FROM node:24-alpine AS runtime

# Non-root user
RUN addgroup -g 1001 -S app && \
    adduser -u 1001 -G app -D -h /app -s /sbin/nologin app

WORKDIR /app
COPY --from=build --chown=app:app /prod/backend .

# Widget embed bundles (real build from @horeca/widget-embed)
# embed.factory.ts resolves __dirname/../../../../widget-embed/dist after flat
# pnpm deploy → /widget-embed/dist. Real bundles built в Stage 2 above.
COPY --from=build --chown=app:app /app/apps/widget-embed/dist /widget-embed/dist

ENV NODE_ENV=production
# Node compile cache (V8 bytecode, env var with default-on в Node 23+)
ENV NODE_COMPILE_CACHE=/tmp/node-compile-cache

USER app
EXPOSE 3000

# Node 24 type stripping handles .ts source directly (no build needed для
# backend). YC Serverless Container injects PORT env var.
#
# Canon Q2 2026 (verified empirically May 19): `--experimental-strip-types`
# THROWS `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when ANY transitive
# .ts file is resolved inside a `node_modules/` path. pnpm deploy --legacy
# preserves workspace deps как nested node_modules (e.g. @horeca/shared),
# triggering this trap on first import. The Node-team-canonical workaround
# is `--import=amaro/strip` — same Amaro library Node uses internally, but
# routed через user-space module hook так что node_modules guard не fires.
# Amaro v1.0+ is pinned в package.json deps.
#
# Note: `pnpm deploy --legacy` flattens backend в /app/src/index.ts (NOT
# nested apps/backend/src/) so entrypoint is just `src/index.ts`.
CMD ["node", "--import=amaro/strip", "src/index.ts"]
