# syntax=docker/dockerfile:1

# ---- stage 1: install everything, build the client
FROM node:24-alpine AS build
WORKDIR /app
# manifests first: this layer is cached until a dependency changes
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

# ---- stage 2: only what runs
FROM node:24-alpine AS run
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
# production dependencies of the server and shared only: no vite, tsc, biome, vitest
RUN npm ci --omit=dev -w shared -w server && npm cache clean --force
# Node strips the types itself, so the sources are what runs
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
RUN mkdir -p server/logs && chown -R node:node server/logs

# the version the server reports in /health and /metrics
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# exec form: SIGTERM goes to node itself, not to a shell that would swallow it
CMD ["node", "server/src/index.ts"]
