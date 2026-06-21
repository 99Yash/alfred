/**
 * m7a structural smoke test.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-google.ts
 *
 * What this verifies *without* a real Google OAuth setup:
 *   - The OAuth helper builds an authorize URL (or surfaces a clear
 *     error when env vars are missing).
 *   - The /api/integrations/google routes are mounted and gated by
 *     auth (unauthenticated requests get 401).
 *
 * What this verifies *with* a working OAuth setup + a connected Google
 * account in `integration_credentials`:
 *   - The ingestor can fetch + write documents end-to-end.
 *   - Re-running is idempotent (no duplicate document rows).
 *
 * The script does not initiate the browser OAuth dance — that's a
 * manual one-time step. The instructions print at the end if no
 * credential exists yet.
 */
import { closeConnections, warmPool } from "@alfred/api";
import { db } from "@alfred/db";
import { documents, integrationCredentials } from "@alfred/db/schemas";
import {
  ALL_GOOGLE_SCOPES,
  buildAuthorizeUrl,
  ingestRecentGmail,
} from "@alfred/integrations/google";
import { serverEnv } from "@alfred/env/server";
import { and, eq } from "drizzle-orm";

async function main() {
  await warmPool();

  // ---- Phase 1: env + URL builder ------------------------------------------
  const env = serverEnv();
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REDIRECT_URI
  ) {
    console.log(
      "[smoke-google] OAuth env vars not set — skipping URL + ingest checks.",
    );
    printOAuthSetupInstructions();
    return;
  }

  // Pass the full grant explicitly: the no-scopes default now resolves to
  // the public (restricted-free) set, but this smoke checks the full
  // Gmail-ingestion grant builds.
  const url = buildAuthorizeUrl({
    state: "smoke-test-state",
    scopes: ALL_GOOGLE_SCOPES,
  });
  console.log("[smoke-google] authorize URL builds OK:");
  console.log(`   ${url.slice(0, 120)}…\n`);

  // ---- Phase 2: live routes ------------------------------------------------
  const baseUrl = "http://localhost:3001";
  console.log(
    `[smoke-google] probing ${baseUrl}/api/integrations/google/connect (no auth)…`,
  );
  try {
    const res = await fetch(`${baseUrl}/api/integrations/google/connect`, {
      redirect: "manual",
    });
    if (res.status !== 401) {
      console.warn(
        `[smoke-google] WARN expected 401 from /connect without auth, got ${res.status}`,
      );
    } else {
      console.log(
        "[smoke-google] /connect correctly returned 401 without auth ✓",
      );
    }
  } catch (err) {
    console.warn(
      `[smoke-google] WARN could not reach server (is it running?): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ---- Phase 3: ingestion against a real credential ------------------------
  // Pick the first connected Google account, regardless of user. For
  // single-user alfred this is fine; in multi-user it'd take a userId.
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "google"))
    .limit(1);
  const cred = rows[0];

  if (!cred) {
    console.log("\n[smoke-google] no Google credential found in DB.");
    printConnectInstructions();
    return;
  }

  console.log(
    `[smoke-google] running ingestion against ${cred.accountLabel ?? cred.id} (user=${cred.userId})…`,
  );
  const before = await countDocs(cred.userId);
  const result = await ingestRecentGmail({
    credentialId: cred.id,
    query: "newer_than:7d",
    maxMessages: 25,
  });
  const after = await countDocs(cred.userId);

  console.log(`[smoke-google] result: ${JSON.stringify(result, null, 2)}`);
  console.log(
    `[smoke-google] documents before=${before} after=${after} delta=${after - before}`,
  );

  // Idempotency check: rerun must add 0 rows.
  const rerun = await ingestRecentGmail({
    credentialId: cred.id,
    query: "newer_than:7d",
    maxMessages: 25,
  });
  const final = await countDocs(cred.userId);
  if (final !== after) {
    throw new Error(
      `idempotency failed: doc count changed from ${after} → ${final} on rerun (inserted=${rerun.inserted})`,
    );
  }
  console.log(
    `[smoke-google] idempotent rerun: inserted=${rerun.inserted} (expected 0) ✓`,
  );

  // Sanity: documents list lookup by source.
  const sample = await db()
    .select()
    .from(documents)
    .where(
      and(eq(documents.userId, cred.userId), eq(documents.source, "gmail")),
    )
    .limit(3);
  console.log(`[smoke-google] sample subjects:`);
  for (const d of sample) {
    console.log(`   - ${d.title?.slice(0, 80) ?? "(no subject)"}`);
  }

  console.log("\n[smoke-google] PASS");
}

async function countDocs(userId: string): Promise<number> {
  const rows = await db()
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")));
  return rows.length;
}

function printOAuthSetupInstructions() {
  console.log("\nTo provision Google OAuth for local testing:");
  console.log(
    "  1. https://console.cloud.google.com/ → select or create a project.",
  );
  console.log("  2. APIs & Services → Library → enable 'Gmail API'.");
  console.log(
    "  3. APIs & Services → OAuth consent screen → External, add yourself as a test user.",
  );
  console.log(
    "  4. APIs & Services → Credentials → Create credentials → OAuth client ID",
  );
  console.log("     - Application type: Web application");
  console.log(
    "     - Authorized redirect URI: http://localhost:3001/api/integrations/google/callback",
  );
  console.log("  5. Copy the Client ID + Client Secret into apps/server/.env:");
  console.log("       GOOGLE_OAUTH_CLIENT_ID=...");
  console.log("       GOOGLE_OAUTH_CLIENT_SECRET=...");
  console.log("  6. Restart the dev server, then re-run this smoke test.");
}

function printConnectInstructions() {
  console.log("To connect your Google account:");
  console.log(
    "  1. Sign in at http://localhost:3000 (existing Better Auth flow).",
  );
  console.log(
    "  2. Open http://localhost:3001/api/integrations/google/connect in the SAME browser.",
  );
  console.log("     (the route requires the auth cookie from step 1)");
  console.log("  3. Approve the consent screen.");
  console.log(
    "  4. You'll be redirected back to the SPA with `?google_connected=<email>`.",
  );
  console.log("  5. Re-run this smoke test to exercise ingestion.");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-google] FAIL",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections().catch(() => {});
  });
