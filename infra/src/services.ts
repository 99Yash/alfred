// The two app services, declared to match the live Railway configuration.
//
// The first `alchemy deploy --adopt` takes each over in place — the apply-time
// ownership probe finds the dashboard-created service and feeds its
// attributes into the update, so nothing is duplicated (probe evidence:
// docs/research/alchemy-railway-probe.md, "Cutover gate experiments").
//
// `publicDomain: false` on purpose: it never deletes a domain this program
// does not own, so the existing generated domains
// (server-production-c138.up.railway.app, web-production-125ee.up.railway.app)
// stay exactly as they are and stay dashboard-managed. A later slice can claim
// them once the owner agrees on which domain each env binding should read.
import * as Railway from "@alchemy.run/railway";
import { Alfred, PRODUCTION_ENVIRONMENT_ID } from "./project.ts";

const REGION = "asia-southeast1-eqsg3a";

const REPO = "99Yash/alfred";

const BRANCH = "main";

export const Server = Railway.Service("Server", {
  project: Alfred,
  environment: { environmentId: PRODUCTION_ENVIRONMENT_ID },
  name: "server",
  region: REGION,
  repo: REPO,
  branch: BRANCH,
  builder: "RAILPACK",
  buildCommand: "pnpm install --frozen-lockfile && pnpm turbo run build --filter=server",
  startCommand: "node apps/server/dist/index.js",
  healthcheck: "/health",
  publicDomain: false,
});

export const Web = Railway.Service("Web", {
  project: Alfred,
  environment: { environmentId: PRODUCTION_ENVIRONMENT_ID },
  name: "web",
  region: REGION,
  repo: REPO,
  branch: BRANCH,
  builder: "RAILPACK",
  buildCommand: "pnpm install --frozen-lockfile && pnpm turbo run build --filter=web",
  publicDomain: false,
});
