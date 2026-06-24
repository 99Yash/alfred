/**
 * Probe a Railway API token against the candidate validation queries so the
 * live schema can be confirmed before it is trusted on the connect path.
 * Read-only; talks only to backboard.railway.app (no DB / serverEnv), so it
 * runs without --env-file.
 *
 *   # preferred — token not visible in `ps`:
 *   $ RAILWAY_TOKEN=xxxx pnpm --filter server tsx src/scripts/probe-railway-token.ts
 *   # or:
 *   $ pnpm --filter server tsx src/scripts/probe-railway-token.ts <token>
 *
 * Run it once with an ACCOUNT token and once with a WORKSPACE token. What to
 * look for: does `apiToken { workspaces { id name } }` resolve (the field the
 * connect path uses to mint a stable `workspace:<id>` identity — verified
 * 2026-06-24), or does it error? `projects { ... team }` is the shape workspace
 * tokens are confirmed to answer (railwayapp/cli#845) and the connect path's
 * fallback when introspection comes back empty/ambiguous.
 */

const RAILWAY_API = "https://backboard.railway.app/graphql/v2";

async function run(
  token: string,
  label: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(RAILWAY_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    console.log(`\n=== ${label} ===\nHTTP ${res.status}\n${text.slice(0, 1500)}`);
  } catch (err) {
    console.log(`\n=== ${label} ===\nthrew: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const token = process.env.RAILWAY_TOKEN ?? process.argv[2];
  if (!token) {
    console.error("Pass a token via RAILWAY_TOKEN=... or as the first argument.");
    process.exit(1);
  }

  await run(token, "me (account identity)", `query { me { id name email } }`);
  await run(
    token,
    "apiToken { workspaces { id name } }  <- connect path uses this for workspace identity",
    `query { apiToken { workspaces { id name } } }`,
  );
  await run(
    token,
    "apiTokens (plural, documented, account-scoped)",
    `query { apiTokens { edges { node { id name } } } }`,
  );
  await run(
    token,
    "projects { ... team }  (workspace-token-safe)",
    `query { projects { edges { node { id name team { id name } } } } }`,
  );

  const workspaceId = process.env.RAILWAY_WORKSPACE_ID;
  if (workspaceId) {
    await run(
      token,
      `workspace(workspaceId: ${workspaceId})`,
      `query workspace($workspaceId: String!) { workspace(workspaceId: $workspaceId) { id name } }`,
      { workspaceId },
    );
  } else {
    console.log(
      "\n(set RAILWAY_WORKSPACE_ID=... — e.g. a workspaces[].id apiToken returned — to also probe workspace(workspaceId:))",
    );
  }
}

void main();
