FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM node:22.23.1-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM build AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/index.js"]

FROM build AS migrate
USER node
CMD ["node", "--import", "tsx", "scripts/db-migrate.ts"]

