FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
# Vite inlines import.meta.env.VITE_* at build time, so the Yandex Maps key
# must be present during `npm run build`. Passed in as a build arg; only the
# resulting client bundle (not a persistent env layer) carries the value.
ARG VITE_YANDEX_MAPS_API_KEY=""
ENV VITE_YANDEX_MAPS_API_KEY=$VITE_YANDEX_MAPS_API_KEY
RUN npm run build
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

