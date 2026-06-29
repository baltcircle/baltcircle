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
ENV DATABASE_PATH=/app/data/data.db
RUN mkdir -p /app/data
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 5000
CMD ["node", "dist/index.cjs"]
