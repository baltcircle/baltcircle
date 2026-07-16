# syntax=docker/dockerfile:1.4
FROM node:20-bookworm-slim AS deps
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

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# Yandex Cloud managed-PostgreSQL CA, required for sslmode=verify-full at
# runtime. Baked into the image and pointed at via NODE_EXTRA_CA_CERTS so the
# pg pool can verify the server certificate.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL -o /etc/ssl/certs/yc-root.crt https://storage.yandexcloud.net/cloud-certs/CA.pem \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/yc-root.crt
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
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
EXPOSE 5000
CMD ["node", "dist/index.cjs"]
