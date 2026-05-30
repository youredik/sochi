# =============================================================================
# Sochi backend — multi-stage canonical 2026-05-20 (pnpm fetch + offline)
# =============================================================================
#
# Pattern (pnpm.io/docker canonical 2026):
#   Stage 1 `base`     — pnpm via corepack
#   Stage 2 `deps`     — COPY only lockfile + package.json files → pnpm fetch
#                        → layer cached unless lockfile changes
#   Stage 3 `build`    — COPY source → pnpm install --offline (cached store)
#                        → build artifacts → pnpm deploy
#   Stage 4 `runtime`  — runtime-only prod node_modules + dist
#
# Empirical baseline (run #12): build-push 310s. Cause: `COPY . /app` ДО
# `pnpm install` → любая source change invalidates install layer (no cache).
# Multi-stage с separated deps layer + zstd cache compression (CI --cache-to)
# → ожидаемо cold ~120s, warm ~60s (Depot benchmark: 13min→5min ≈ −60% zstd).
#
# Native modules (sharp 0.34, @ydbjs) — install via `pnpm install --offline`
# uses cached store, postinstall scripts (bun, esbuild, sharp) запускаются
# нормально.
#
# Backend runtime: `@hono/node-server` (runtime-agnostic) + Node 24 с native
# TypeScript stripping (since 22.6, stable 23.6).
#
# Alpine choice: 6 CVEs vs Debian slim 27 (stankoff finding 2026-04). YC
# Serverless Container accepts any image — no glibc requirement.

# --- Stage 1: base (pnpm setup) ---
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app

# --- Stage 2: deps (lockfile-cached layer) ---
# COPY ONLY package.json files + lockfile. Layer hash invalidates ТОЛЬКО
# на изменение manifests, не на source-edit.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/widget-embed/package.json ./apps/widget-embed/
COPY packages/shared/package.json ./packages/shared/
# `pnpm fetch` — populate /pnpm/store без node_modules symlinks.
# BuildKit cache mount хранит store между local invocations; в CI
# `--cache-to type=registry,...,compression=zstd` экспортирует слой.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# --- Stage 3: build (source → artifacts) ---
FROM deps AS build
# COPY source ПОСЛЕ deps stage — source changes только этот слой invalidate.
COPY . /app
# `pnpm install --offline` — uses cached store from deps stage, no network.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @horeca/backend... \
      --filter @horeca/shared... \
      --filter @horeca/widget-embed...

# Build shared (Node не strips types в node_modules → needs build)
RUN pnpm --filter @horeca/shared build

# Build widget-embed (embed.js + booking-flow.js JS bundles).
# Backend embed.factory.ts reads these at runtime via __dirname/../../../../
# widget-embed/dist after flat pnpm deploy.
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

# --- Stage 4: runtime ---
FROM node:24-alpine AS runtime

# Non-root user
RUN addgroup -g 1001 -S app && \
    adduser -u 1001 -G app -D -h /app -s /sbin/nologin app

WORKDIR /app
COPY --from=build --chown=app:app /prod/backend .

# Widget embed bundles (resolved via __dirname/../../../../widget-embed/dist
# after flat pnpm deploy → /widget-embed/dist).
COPY --from=build --chown=app:app /app/apps/widget-embed/dist /widget-embed/dist

ENV NODE_ENV=production
# V8 bytecode cache (default-on в Node 23+, explicit для clarity)
ENV NODE_COMPILE_CACHE=/tmp/node-compile-cache

USER app
EXPOSE 3000

# Node 24 type stripping handles .ts source directly. `--import=amaro/strip`
# bypasses node_modules guard в nested pnpm deploy layout — canon Q2 2026
# verified empirically May 19. Amaro v1.0+ в deps.
CMD ["node", "--import=amaro/strip", "src/index.ts"]
