// The two app services, declared to match the live Railway configuration.
//
// The first `alchemy deploy --adopt` takes each over in place — the apply-time
// ownership probe finds the dashboard-created service and feeds its
// attributes into the update, so nothing is duplicated (probe evidence:
// docs/research/alchemy-railway-probe.md, "Cutover gate experiments").
//
// The deploy trigger is the context upload: Railway builds the repo root
// (filtered by the root `.dockerignore`) with the per-service Dockerfile
// under `docker/` — the `dockerfilePath` prop points each service at its
// file, and Dockerfile detection wins over the Railpack fallback. The deploy
// GitHub Action on push to main runs `alchemy deploy` (ADR-0128). There is
// no GitHub trigger on the Railway side; `alchemy deploy` is the only
// redeploy path.
//
// CI runners hold no local state, so every CI deploy re-adopts the services
// in place (`deploy --adopt`); ownership probes at apply time find the
// existing service by id and update it, never duplicating.
//
// `publicDomain: false` on purpose: it never deletes a domain this program
// does not own, so the existing generated domains
// (server-production-c138.up.railway.app, web-production-125ee.up.railway.app)
// stay exactly as they are and stay dashboard-managed. A later slice can claim
// them once the owner agrees on which domain each env binding should read.
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as Railway from "@alchemy.run/railway";
import { Alfred, PRODUCTION_ENVIRONMENT_ID } from "./project.ts";

const REGION = "asia-southeast1-eqsg3a";

const REPO = "99Yash/alfred";

// The program runs from `infra/`; the git worktree is its parent. The
// absolute path doubles as the uploaded build context (absolute paths
// ignore the caller's cwd).
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * The commit and repo identity written into the server environment at deploy
 * time (ADR-0128 D2). Railway's git integration injects `RAILWAY_GIT_COMMIT_SHA`
 * only on git-triggered deploys — gone now the source is a context upload — so
 * the consumers re-source to these variables and the program rewrites them on
 * every deploy. CI supplies `GITHUB_SHA` (and its checkout is clean by
 * definition); a local deploy falls back to HEAD and refuses a dirty tree:
 * the uploaded working tree is what ships, so uncommitted changes would ship
 * unnamed by the written commit.
 */
function deployedCommitSha(): string {
  const fromCi = process.env.GITHUB_SHA; // drift-ok: the infra program is outside app code (ADR-0128 D1)

  if (fromCi) return fromCi;

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (status.trim() !== "") {
    throw new Error(
      "Deploy from a clean tree, or set GITHUB_SHA: the uploaded context is the " +
        "working tree, so uncommitted changes would ship without the written " +
        "commit naming them.",
    );
  }

  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

const [REPO_OWNER, REPO_NAME] = REPO.split("/");

export const Server = Railway.Service("Server", {
  project: Alfred,
  environment: { environmentId: PRODUCTION_ENVIRONMENT_ID },
  name: "server",
  region: REGION,
  context: REPO_ROOT,
  dockerfilePath: "docker/server.Dockerfile",
  builder: "RAILPACK",
  buildCommand: "pnpm install --frozen-lockfile && pnpm turbo run build --filter=server",
  // Migrate, then sync model prices, before the new deployment starts. The live
  // manifest holds `["pnpm db:predeploy"]`; the provider compares the one-item
  // array to this string, so the declaration writes nothing.
  preDeploy: { command: "pnpm db:predeploy" },
  startCommand: "node apps/server/dist/index.js",
  healthcheck: "/health",
  // Upsert-only (`syncEnv` never deletes an undeclared variable), applied
  // before the deploy it marks needed, so the new deployment reads them.
  env: {
    ALFRED_DEPLOYED_COMMIT_SHA: deployedCommitSha(),
    ALFRED_DEPLOYED_REPO_OWNER: REPO_OWNER,
    ALFRED_DEPLOYED_REPO_NAME: REPO_NAME,
  },
  publicDomain: false,
});

export const Web = Railway.Service("Web", {
  project: Alfred,
  environment: { environmentId: PRODUCTION_ENVIRONMENT_ID },
  name: "web",
  region: REGION,
  context: REPO_ROOT,
  dockerfilePath: "docker/web.Dockerfile",
  builder: "RAILPACK",
  buildCommand: "pnpm install --frozen-lockfile && pnpm turbo run build --filter=web",
  publicDomain: false,
});
