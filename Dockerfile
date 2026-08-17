# syntax=docker/dockerfile:1.4
# Base image pinned by digest for reproducible builds (audit M4). Tag kept in the
# comment for readability. To refresh after an upstream security update, resolve
# the current digest with:
#   docker buildx imagetools inspect node:20-bookworm-slim
# and replace the sha256 below (update both FROM lines to keep them in sync).
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Cache node_modules across builds — only re-installs when package*.json changes
RUN --mount=type=cache,target=/root/.npm \
    npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ARG VITE_YANDEX_MAPS_API_KEY=""
ENV VITE_YANDEX_MAPS_API_KEY=$VITE_YANDEX_MAPS_API_KEY
# Cache Vite build output — only rebuilds changed files
RUN --mount=type=cache,target=/app/node_modules/.cache \
    npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# Yandex Cloud managed-PostgreSQL CA, required for sslmode=verify-full at
# runtime, PLUS the Russian Trusted Root/Sub CA (НУЦ Минцифры) needed so
# outgoing HTTPS requests to the T-Bank acquiring API (securepay.tinkoff.ru,
# see TBANK_API_BASE / server/tbank.ts) keep working once T-Bank migrates its
# TLS certificate from GlobalSign to a chain issued by these CAs. See
# https://developer.tbank.ru/eacq/intro/certificates/migration-russian-trusted-ca
# All three are installed at build time (per official guidance — adding
# certs at runtime instead of at build time can leave the container serving
# stale trust info) via the standard Debian/Ubuntu update-ca-certificates
# mechanism: any cert placed under /usr/local/share/ca-certificates/*.crt is
# picked up and merged into /etc/ssl/certs/ca-certificates.crt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL -o /usr/local/share/ca-certificates/yc-root.crt https://storage.yandexcloud.net/cloud-certs/CA.pem \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY certs/russian_trusted_root_ca.pem /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
COPY certs/russian_trusted_sub_ca.pem /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
RUN update-ca-certificates
# Node.js ignores the OS trust store by default, so it must be pointed at a
# CA bundle explicitly. Point at the system bundle (which now contains the
# Yandex Cloud Postgres CA and the T-Bank Russian Trusted CA chain, merged
# above by update-ca-certificates) so this single env var keeps covering
# both integrations going forward.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# App data now lives in managed PostgreSQL (DATABASE_URL at runtime), not a
# local SQLite file. No /app/data directory needed.
# Run as the unprivileged `node` user (uid 1000, shipped in the base image)
# instead of root, so a compromise inside the container cannot trivially
# escalate on the host (audit H3). App files are chowned to `node`, and the
# runtime uploads directory (support-chat attachments, written to /app/uploads
# by default) is pre-created and owned by `node` so the process can write there.
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Versioned Drizzle migrations (audit HIGH #17): applied at runtime by
# server/db/migrate.ts, read from disk relative to process.cwd() (/app), not
# bundled into dist/index.cjs.
COPY --from=build --chown=node:node /app/migrations ./migrations
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
# Strip the npm CLI (and corepack) from the runtime image (audit HIGH #22).
# This process only ever runs `node dist/index.cjs` directly — npm/npx are
# never invoked at runtime, they only matter at build time (already done in
# the `deps`/`build` stages above) and in the throwaway migration container
# in deploy.yml (a separate, unrelated node:20-bookworm-slim invocation).
# The bundled npm CLI ships its own vendored dependencies (tar, minimatch,
# sigstore, ip-address, etc.) that are entirely unrelated to this app's
# package.json/package-lock.json — Trivy flagged CVE-2026-59873 (tar,
# CRITICAL) and several HIGH CVEs in that vendored code on 2026-08-17.
# Since none of it is reachable from our running process, removing it
# outright closes the finding at the root instead of chasing per-CVE
# ignores that would need to be revisited on every npm release.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 5000
EXPOSE 5100
# Liveness probe against the lightweight public catalog endpoint (audit M4). Uses
# node's built-in http client so no extra package is needed (curl is purged above).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/bikes',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "dist/index.cjs"]
