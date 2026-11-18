# The server's Railway build (ADR-0128). Railway uses this file because the
# service's `dockerfilePath` points at it — with a build context present,
# Dockerfile detection wins over the Railpack fallback.
#
# One stage on purpose: the runtime shape stays exactly what Railpack built
# today — the repo, dev deps included (tsdown keeps npm deps external, so the
# dist needs `node_modules` beside it), started by the service's
# `startCommand` (`node apps/server/dist/index.js`).
#
# Dockerfile builds do not see service variables unless declared with `ARG`
# (docs.railway.com/builds/dockerfiles). The four ARGs feed the post-build
# Sentry step (`apps/server/scripts/sentry-release.mjs`): the auth triplet
# and the release name — the deploy commit, written by the infra program.
# ARG values land in image history; the token is a source-map upload token
# and the image is private to this project.
FROM node:26-slim

RUN npm install -g pnpm@11.26.0

WORKDIR /app

COPY . .

ARG ALFRED_DEPLOYED_COMMIT_SHA
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT

RUN --mount=type=cache,id=s/822564df-4127-463b-b7ac-6174125951d9-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && pnpm turbo run build --filter=server
