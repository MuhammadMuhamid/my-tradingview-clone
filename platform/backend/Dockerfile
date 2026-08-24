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
# EVERY registered optimizer tree, code only.
#
# OPT-24: this stage used to name three directories by hand. One of them
# (`sr_optimizer1h`) does not exist, so the build failed outright, and three
# trees that five launchd services actually run — `lean_optimizer15m`,
# `optimizer1y5m`, `optimizer1y5m_ma` — were never copied. The trees are now
# copied as a set, so adding a tree cannot silently leave it out of the image.
#
# `.dockerignore` keeps results/best/index/archive out, and
# compose.compute.yml bind-mounts the host history over /app/<tree> at runtime.
COPY full3y1h ./full3y1h
COPY holdout1h ./holdout1h
COPY lean3y15m ./lean3y15m
COPY lean_optimizer15m ./lean_optimizer15m
COPY lean_wf_15m ./lean_wf_15m
COPY lean_wf_15m_current ./lean_wf_15m_current
COPY lean_wf_fixedsize ./lean_wf_fixedsize
COPY optimizer1y15m ./optimizer1y15m
COPY optimizer1y15m_wf ./optimizer1y15m_wf
COPY optimizer1y1h ./optimizer1y1h
COPY optimizer1y1h_wf_trail ./optimizer1y1h_wf_trail
COPY optimizer1y5m ./optimizer1y5m
COPY optimizer1y5m_ma ./optimizer1y5m_ma
COPY wf6m_1h ./wf6m_1h
# No default tree: each compose service names its own optimizer explicitly.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "optimizer1y1h/optimizer.ts", "--daemon", "--round", "50"]
