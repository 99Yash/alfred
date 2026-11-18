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
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as Railway from "@alchemy.run/railway";
import { Alfred, PRODUCTION_ENVIRONMENT_ID } from "./project.ts";

const REGION = "asia-southeast1-eqsg3a";

const REPO = "99Yash/alfred";

const BRANCH = "main";

// The program runs from `infra/`; the git worktree is its parent.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * The commit and repo identity written into the server environment at deploy
 * time (ADR-0128 D2). Railway's git integration injects `RAILWAY_GIT_COMMIT_SHA`
 * only on git-triggered deploys; a context-upload deploy sets nothing, so the
 * consumers re-source to these variables and the program rewrites them on every
 * deploy. CI supplies `GITHUB_SHA`; a local deploy falls back to HEAD. (A
 * dirty-tree gate belongs to the trigger-switch slice: only when the uploaded
 * working tree is what ships must it match the SHA.)
 *
 * The raw `process.env` read is deliberate: `serverEnv()` validates the server's
 * whole environment (app secrets, DB URL), which the infra program must not
 * require — the program binds to the app through environment variables only
 * (ADR-0128 D1).
 */
function deployedCommitSha(): string {
  return (
    process.env.GITHUB_SHA ?? // drift-ok: the infra program is outside app code (ADR-0128 D1)
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim()
  );
}

const [REPO_OWNER, REPO_NAME] = REPO.split("/");

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
  repo: REPO,
  branch: BRANCH,
  builder: "RAILPACK",
  buildCommand: "pnpm install --frozen-lockfile && pnpm turbo run build --filter=web",
  publicDomain: false,
});
