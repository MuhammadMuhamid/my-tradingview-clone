FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The migration runner resolves SQL files beside the compiled JavaScript in
# production. TypeScript compilation does not copy non-code assets itself.
COPY --from=build /app/src/db/migrations ./dist/db/migrations
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM node:20-bookworm-slim AS optimizer
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# The three surviving optimizer trees (2026-07-30). Code only — .dockerignore
# keeps results/best/index/archive out, and compose.compute.yml bind-mounts the
# host history over /app/<tree> at runtime.
COPY optimizer1y1h ./optimizer1y1h
COPY optimizer1y15m ./optimizer1y15m
COPY sr_optimizer1h ./sr_optimizer1h
# No default tree: each compose service names its own optimizer explicitly.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "optimizer1y1h/optimizer.ts", "--daemon", "--round", "50"]
