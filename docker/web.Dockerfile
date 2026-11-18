# The web's Railway build (ADR-0128). Railway uses this file because the
# service's `dockerfilePath` points at it.
#
# Two stages: the build stage compiles the SPA; the runtime stage serves the
# output with Caddy. Railpack's own static SPA serving is not available to a
# Dockerfile build, so this Caddyfile is the serving surface — SPA fallback
# included, listening on Railway's injected `PORT`.

FROM node:26-slim AS build

RUN npm install -g pnpm@11.26.0

WORKDIR /app

COPY . .

# Railway's service variables reach a Dockerfile build only through `ARG`
# (docs.railway.com/builds/dockerfiles). `VITE_API_URL` is baked into the SPA
# bundle at build time; without this line the bundle falls back to the dev
# default `http://localhost:3001` and prod calls nothing.
ARG VITE_API_URL

RUN --mount=type=cache,id=s/2155bb3b-873d-49c2-a690-e2d58f67dc90-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && pnpm turbo run build --filter=web

FROM caddy:2-alpine

COPY --from=build /app/apps/web/dist /srv
COPY docker/web.Caddyfile /etc/caddy/Caddyfile
