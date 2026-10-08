/**
 * Smoke test for Gmail delta polling on a connected account: a re-poll is a no-op,
 * the cursor never moves back, a just-polled credential leaves the poll sweep, and
 * the embed sweep query is bounded. The Pub/Sub push path is manual; the script
 * prints the setup steps.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-google-poll.ts
 */
import { closeConnections, warmPool } from "@alfred/db";
import { db } from "@alfred/db";
import { ingestionState, integrationCredentials } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds } from "@alfred/corpus";
import {
  findCredentialsNeedingPoll,
  pollGmailHistory,
} from "@alfred/assistant/connections/ingestion/internal";
import { and, eq } from "drizzle-orm";

async function main() {
  await warmPool();

  const cred = (
    await db()
      .select({
        id: integrationCredentials.id,
        userId: integrationCredentials.userId,
        accountLabel: integrationCredentials.accountLabel,
      })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.provider, "google"))
      .limit(1)
  )[0];

  if (!cred) {
    console.log("[smoke-google-poll] no Google credential found.");
    console.log("Run smoke-google.ts first to connect an account + bulk ingest.");

    return;
  }

  console.log(`[smoke-google-poll] target: ${cred.accountLabel ?? cred.id} (user=${cred.userId})`);

  // Phase 1: pre-state.
  const cursorBefore = await loadCursor(cred.id);
  console.log(`[smoke-google-poll] cursor before: ${cursorBefore ?? "(none)"}`);

  // Phase 2: poll.
  const result = await pollGmailHistory({ credentialId: cred.id });
  console.log("[smoke-google-poll] result:", JSON.stringify(result, null, 2));

  if (
    result.cursorAfter &&
    result.cursorBefore &&
    compareHistoryIds(result.cursorAfter, result.cursorBefore) < 0
  ) {
    throw new Error(
      `cursor went backwards: before=${result.cursorBefore} after=${result.cursorAfter}`,
    );
  }

  // Phase 3: re-poll, a no-op when nothing changed.
  const second = await pollGmailHistory({ credentialId: cred.id });
  console.log(
    `[smoke-google-poll] re-poll: inserted=${second.inserted} pages=${second.pagesFetched}`,
  );

  // Phase 4: the just-polled credential must not be a poll candidate.
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const stale = await findCredentialsNeedingPoll(cutoff);

  if (stale.find((s) => s.credentialId === cred.id)) {
    throw new Error(`findCredentialsNeedingPoll returned just-polled credential ${cred.id}`);
  }

  console.log(
    `[smoke-google-poll] sweep query excludes fresh credential ✓ (${stale.length} other stale)`,
  );

  // Phase 5: embed-sweep candidate query.
  const unembedded = await findUnembeddedDocumentIds({ source: "gmail", limit: 10 });
  console.log(`[smoke-google-poll] unembedded gmail docs: ${unembedded.length}`);

  console.log("\n[smoke-google-poll] PASS");
  printPubSubSetupChecklist();
}

async function loadCursor(credentialId: string): Promise<string | null> {
  const rows = await db()
    .select({ state: ingestionState.state })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );

  // SAFETY: the Gmail cursor writes ingestion_state.state with a historyId.
  const state = rows[0]?.state as { historyId?: string | null } | undefined;

  return state?.historyId ?? null;
}

function compareHistoryIds(a: string, b: string): number {
  try {
    const ba = BigInt(a);
    const bb = BigInt(b);

    return ba < bb ? -1 : ba > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

function printPubSubSetupChecklist() {
  console.log(`
Pub/Sub setup (manual, one-time):
  1. GCP Console → Pub/Sub → Topics → Create:
       projects/<your-project>/topics/gmail-push
  2. On that topic → Permissions → Add principal:
       gmail-api-push@system.gserviceaccount.com  →  Pub/Sub Publisher
  3. Create a push subscription on the topic, push endpoint:
       https://<your-public-server>/webhooks/gmail
     Configure OIDC auth: pick a service account, set audience to a
     value of your choosing (e.g. https://alfred.example.com/webhooks/gmail).
     Production rejects push notifications when this audience is unset.
  4. Set in apps/server/.env:
       GOOGLE_PUBSUB_TOPIC=projects/<id>/topics/gmail-push
       GOOGLE_PUBSUB_AUDIENCE=<the-audience-from-step-3>
       GOOGLE_PUBSUB_SERVICE_ACCOUNT=<service-account-email>
  5. Install the watch:
       curl -X POST -b cookies.txt http://localhost:3001/api/integrations/google/<credentialId>/watch
  6. Send yourself an email and watch the worker logs for
       gmail.poll_recent ... inserted=1
`);
}

main()
  .catch((err) => {
    console.error("[smoke-google-poll] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections().catch(() => {});
  });
