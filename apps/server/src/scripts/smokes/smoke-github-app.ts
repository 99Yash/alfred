/**
 * GitHub App smoke against real GitHub (ADR-0052): the App JWT signs and `GET /app`
 * accepts it, installations list, an installation token works, and the install URL
 * builds. With no installation, it prints how to install.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-github-app.ts
 */
import { z } from "zod";
import { closeConnections, warmPool } from "@alfred/db";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { buildInstallUrl, getInstallationToken, mintAppJwt } from "@alfred/integrations/github";
import { serverEnv } from "@alfred/env/server";
import { eq } from "drizzle-orm";
import { toMessage } from "@alfred/contracts";

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

const githubAppSchema = z.object({ id: z.number(), slug: z.string(), name: z.string() });

const githubInstallationsSchema = z.array(
  z.object({
    id: z.number(),
    account: z.object({ login: z.string().optional() }).nullish(),
  }),
);

const githubRepositoriesSchema = z.object({ total_count: z.number().optional() });

async function main() {
  await warmPool();
  const env = serverEnv();

  console.log("[smoke-github-app] install URL builds:");
  console.log(`   ${buildInstallUrl("smoke-state").slice(0, 120)}\n`);

  // Phase 1: the App JWT is valid.
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

  const app = githubAppSchema.parse(await appRes.json());
  console.log(
    `[smoke-github-app] App JWT accepted — app #${app.id} "${app.name}" (slug ${app.slug})`,
  );

  if (String(app.id) !== env.GITHUB_APP_ID) {
    console.warn(
      `[smoke-github-app] WARNING: GITHUB_APP_ID (${env.GITHUB_APP_ID}) != live app id (${app.id})`,
    );
  }

  // Phase 2: installations.
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

  const installations = githubInstallationsSchema.parse(await instRes.json());

  console.log(`[smoke-github-app] installations: ${installations.length}`);

  const [first] = installations;

  if (!first) {
    console.log("\n[smoke-github-app] No installation yet. Install the App:");
    console.log(`   ${buildInstallUrl("smoke-state")}\n`);
  } else {
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

    const repos = githubRepositoriesSchema.parse(await repoRes.json());
    console.log(`   → installation can see ${repos.total_count ?? "?"} repositories`);
  }

  // Phase 3: stored credential.
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

try {
  await main();
} catch (err) {
  console.error(`[smoke-github-app] error: ${toMessage(err)}`);
  process.exitCode = 1;
} finally {
  await closeConnections();
}
