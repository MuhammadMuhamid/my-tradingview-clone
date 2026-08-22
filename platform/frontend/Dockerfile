FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=$BACKEND_URL
# Next inlines process.env into Edge middleware at BUILD time, so the sign-in
# gate has to be decided here rather than only in compose. Containers are the
# deployed app and always authenticate; local `next dev` leaves this unset.
ARG AUTH_ENABLED=true
ENV AUTH_ENABLED=$AUTH_ENABLED
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
