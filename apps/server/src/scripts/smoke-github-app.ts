/**
 * GitHub App structural smoke test (ADR-0052).
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-github-app.ts
 *
 * What this verifies against real GitHub, without a browser dance:
 *   - The private key loads (PKCS#1) and `jose` signs a valid App JWT.
 *   - GitHub accepts the JWT: `GET /app` returns this App's identity.
 *   - `GET /app/installations` lists installations; if the user has
 *     installed the App, it mints an installation token and confirms it
 *     works (`GET /installation/repositories`).
 *   - The install URL builds.
 *
 * If no installation exists yet, it prints how to install — that's the
 * one manual step (the browser connect flow).
 */
import { closeConnections, warmPool } from "@alfred/api";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { buildInstallUrl, getInstallationToken, mintAppJwt } from "@alfred/integrations/github";
import { serverEnv } from "@alfred/env/server";
import { eq } from "drizzle-orm";

const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "alfred-app-smoke",
} as const;
const GITHUB_FETCH_TIMEOUT_MS = 30_000;

function githubSmokeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
}

async function responseSnippet(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

async function main() {
  await warmPool();
  const env = serverEnv();

  console.log("[smoke-github-app] install URL builds:");
  console.log(`   ${buildInstallUrl("smoke-state").slice(0, 120)}\n`);

  // ---- Phase 1: App JWT is valid (GET /app) --------------------------------
  const jwt = await mintAppJwt();
  const appRes = await githubSmokeFetch("https://api.github.com/app", {
    headers: { ...GH, Authorization: `Bearer ${jwt}` },
  });
  if (!appRes.ok) {
    console.error(
      `[smoke-github-app] GET /app failed: ${appRes.status} ${await responseSnippet(appRes)}`,
    );
    process.exitCode = 1;
    return;
  }
  const app = (await appRes.json()) as { id: number; slug: string; name: string };
  console.log(
    `[smoke-github-app] App JWT accepted — app #${app.id} "${app.name}" (slug ${app.slug})`,
  );
  if (String(app.id) !== env.GITHUB_APP_ID) {
    console.warn(
      `[smoke-github-app] WARNING: GITHUB_APP_ID (${env.GITHUB_APP_ID}) != live app id (${app.id})`,
    );
  }

  // ---- Phase 2: installations ----------------------------------------------
  const instRes = await githubSmokeFetch("https://api.github.com/app/installations", {
    headers: { ...GH, Authorization: `Bearer ${jwt}` },
  });
  if (!instRes.ok) {
    console.error(
      `[smoke-github-app] GET /app/installations failed: ${instRes.status} ${await responseSnippet(instRes)}`,
    );
    process.exitCode = 1;
    return;
  }
  const installations = (await instRes.json()) as Array<{
    id: number;
    account?: { login?: string };
  }>;
  console.log(`[smoke-github-app] installations: ${installations.length}`);
  if (installations.length === 0) {
    console.log("\n[smoke-github-app] No installation yet. Install the App:");
    console.log(`   ${buildInstallUrl("smoke-state")}\n`);
  } else {
    const first = installations[0]!;
    console.log(`   → installation #${first.id} on @${first.account?.login ?? "?"}`);
    const { token, expiresAt } = await getInstallationToken(String(first.id));
    console.log(`   → minted installation token (expires ${expiresAt.toISOString()})`);
    const repoRes = await githubSmokeFetch("https://api.github.com/installation/repositories", {
      headers: { ...GH, Authorization: `Bearer ${token}` },
    });
    if (!repoRes.ok) {
      console.error(
        `[smoke-github-app] GET /installation/repositories failed: ${repoRes.status} ${await responseSnippet(repoRes)}`,
      );
      process.exitCode = 1;
      return;
    }
    const repos = (await repoRes.json()) as { total_count?: number };
    console.log(`   → installation can see ${repos.total_count ?? "?"} repositories`);
  }

  // ---- Phase 3: stored credential ------------------------------------------
  const creds = await db()
    .select({
      accountLabel: integrationCredentials.accountLabel,
      installationId: integrationCredentials.installationId,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "github"));
  if (creds.length === 0) {
    console.log("\n[smoke-github-app] No github credential row yet — complete the connect flow.");
  } else {
    for (const c of creds) {
      console.log(
        `[smoke-github-app] credential: @${c.accountLabel} status=${c.status} installation_id=${c.installationId ?? "(none — reconnect needed)"}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(`[smoke-github-app] error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
