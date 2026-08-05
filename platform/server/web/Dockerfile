# Multi-stage build: build the Astro standalone server, then ship only the
# runtime output plus production dependencies. No dev dependencies, no
# source maps, no test files in the final image.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
# Deterministic install from the lockfile. NODE_ENV is deliberately NOT set
# to production here: `npm run build` now runs scripts/validate-env.mjs
# before `astro build` (see package.json and src/env.ts), and that gate
# fails closed only in production mode. This image builds with real
# PUBLIC_SITE_ORIGIN/PORTAL_ORIGIN not yet known — they are supplied at
# container run time — so the build stage stays in its default (non-
# production) mode, where the gate passes on documented localhost
# defaults. An operator who wants origins baked in at image-build time can
# pass NODE_ENV=production plus both origins as build args/env here, and
# the same gate will enforce them — there is no separate build-only check.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY astro.config.mjs tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/env.ts ./src/env.ts

RUN addgroup -S veyora && adduser -S veyora -G veyora
USER veyora

EXPOSE 4321
# The validated entrypoint, not a bare `node entry.mjs`: validate-env.mjs
# runs to completion first and exits non-zero on a bad PUBLIC_SITE_ORIGIN/
# PORTAL_ORIGIN — entry.mjs is never even started, so no port is opened on
# a misconfigured container. `exec` replaces the shell with the server
# process once validation passes, so it still ends up as PID 1 and receives
# Docker's stop signal directly.
CMD ["sh", "-c", "node ./scripts/validate-env.mjs && exec node ./dist/server/entry.mjs"]
