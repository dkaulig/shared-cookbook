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

# REL-0b — drop container privileges. caddy:2-alpine runs as root by
# default (Trivy DS-0002), which is unnecessary for a static SPA host
# listening on an unprivileged port. Create a dedicated user, hand it
# ownership of /srv + /config + /data (Caddy reads Caddyfile there,
# writes its internal state here) and switch USER before EXPOSE.
RUN addgroup -S caddy-user \
  && adduser -S -G caddy-user -H caddy-user \
  && mkdir -p /config /data /srv \
  && chown -R caddy-user:caddy-user /config /data /srv

COPY --chown=caddy-user:caddy-user --from=build /repo/apps/web/dist /srv
COPY --chown=caddy-user:caddy-user apps/web/Caddyfile /etc/caddy/Caddyfile

USER caddy-user
EXPOSE 5173
