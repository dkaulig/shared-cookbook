# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

# Copy workspace manifests first for dependency-layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

# Copy the rest of the workspace source.
COPY packages/ packages/
COPY apps/web/ apps/web/

RUN pnpm --filter @familien-kochbuch/web build

FROM caddy:2-alpine AS runtime
COPY --from=build /repo/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 5173
