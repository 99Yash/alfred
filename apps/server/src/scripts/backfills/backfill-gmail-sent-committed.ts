/**
 * Ingest deep Gmail sent history as `documents` for the user-model fold (#218),
 * which needs outbound mail. Normal ingest keeps only 30 days.
 *
 * It calls `ingestRecentGmail` directly, not the queue job, so there is no triage
 * fan-out or label reconcile. It does not move the history cursor, because a filtered
 * replay is not a full sync. It never writes to the mailbox. Re-runs are idempotent.
 *
 * Bundled for prod. Dry by default: lists candidate ids. `--commit` ingests, which
 * costs a Gmail `get` and an embed per message.
 *
 *   # preview personal mailbox (writes nothing):
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --emails=yashgouravkar@gmail.com
 *   # commit, last 365d of sent mail:
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --emails=yashgouravkar@gmail.com --newer-than=365d --commit
 *   # every connected Google account, full custom query:
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --all-connected --query="in:sent" --commit
 */
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user as userTable } from "@alfred/db/schemas";
import { getFreshAccessToken, listMessages } from "@alfred/integrations/google";
import { ingestRecentGmail } from "@alfred/assistant/connections/ingestion/internal";
import { and, eq, inArray } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

const ALL_CONNECTED = process.argv.includes("--all-connected");

const DEFAULT_NEWER_THAN = "180d";

const DEFAULT_MAX_MESSAGES = 5000;

const DEFAULT_PAGE_SIZE = 100;

const GMAIL_PAGE_SIZE_CAP = 500;

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));

  return found ? found.slice(prefix.length) : undefined;
}

function parseEmails(): string[] {
  const raw = flagValue("emails");

  if (!raw) return [];

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `--query` wins; otherwise sent mail within the requested horizon. */
function resolveQuery(): string {
  const override = flagValue("query");

  if (override) return override;
  const newerThan = flagValue("newer-than") ?? DEFAULT_NEWER_THAN;

  return `in:sent newer_than:${newerThan}`;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = flagValue(name);

  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer, got: ${raw}`);
  }

  return n;
}

interface TargetCredential {
  credentialId: string;
  userId: string;
  email: string;
  accountLabel: string | null;
  scopes: string[];
}

/** True when the credential has a gmail.* scope. */
function hasGmailScope(scopes: string[]): boolean {
  return scopes.some((s) => s.includes("gmail"));
}

async function resolveTargets(emails: string[]): Promise<TargetCredential[]> {
  const rows = await db()
    .select({
      credentialId: integrationCredentials.id,
      userId: integrationCredentials.userId,
      email: userTable.email,
      accountLabel: integrationCredentials.accountLabel,
      status: integrationCredentials.status,
      scopes: integrationCredentials.scopes,
    })
    .from(integrationCredentials)
    .innerJoin(userTable, eq(userTable.id, integrationCredentials.userId))
    .where(
      ALL_CONNECTED
        ? eq(integrationCredentials.provider, "google")
        : and(eq(integrationCredentials.provider, "google"), inArray(userTable.email, emails)),
    );

  const targets: TargetCredential[] = [];

  for (const r of rows) {
    if (r.status !== "active") {
      console.log(`! skipping credential=${r.credentialId} (${r.email}) — status=${r.status}`);
      continue;
    }

    const scopes = r.scopes;

    if (!hasGmailScope(scopes)) {
      console.log(`! skipping credential=${r.credentialId} (${r.email}) — no gmail scope`);
      continue;
    }

    targets.push({
      credentialId: r.credentialId,
      userId: r.userId,
      email: r.email,
      accountLabel: r.accountLabel,
      scopes,
    });
  }

  return targets;
}

/** List candidate message ids up to the cap. Read-only. */
async function previewCredential(
  t: TargetCredential,
  query: string,
  maxMessages: number,
  pageSize: number,
): Promise<number> {
  const accessToken = await getFreshAccessToken(t.credentialId);
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < maxMessages) {
    const page = await listMessages({
      accessToken,
      q: query,
      maxResults: Math.min(pageSize, maxMessages - ids.length),
      pageToken,
    });

    ids.push(...page.messages.map((m) => m.id));

    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  console.log(
    `  ${t.email}${t.accountLabel ? ` (${t.accountLabel})` : ""}: ~${ids.length} message(s) match (cap ${maxMessages})`,
  );

  return ids.length;
}

async function main() {
  const emails = parseEmails();

  if (!ALL_CONNECTED && emails.length === 0) {
    throw new Error("specify --emails=a@x.com,b@y.com or --all-connected");
  }

  const query = resolveQuery();
  const maxMessages = parsePositiveInt("max-messages", DEFAULT_MAX_MESSAGES);
  const pageSize = Math.min(parsePositiveInt("page-size", DEFAULT_PAGE_SIZE), GMAIL_PAGE_SIZE_CAP);

  await warmPool();

  console.log(
    `# Gmail backfill — mode=${COMMIT ? "COMMIT" : "DRY"} | query="${query}" | ` +
      `maxMessages=${maxMessages} pageSize=${pageSize} | ` +
      `target=${ALL_CONNECTED ? "all-connected" : emails.join(", ")}`,
  );

  const targets = await resolveTargets(emails);

  if (!ALL_CONNECTED) {
    const found = new Set(targets.map((t) => t.email));

    for (const email of emails) {
      if (!found.has(email)) console.log(`! no active Gmail credential for ${email}`);
    }
  }

  if (targets.length === 0) {
    console.log("no Gmail-capable credentials matched — nothing to do");

    return;
  }

  const totals = {
    fetched: 0,
    inserted: 0,
    skipped: 0,
    ignored: 0,
    errors: 0,
    sent: 0,
    inbound: 0,
    chunks: 0,
  };

  for (const t of targets) {
    console.log(`\n=== ${t.email} (credential=${t.credentialId}) ===`);

    try {
      if (!COMMIT) {
        await previewCredential(t, query, maxMessages, pageSize);
        continue;
      }

      const result = await ingestRecentGmail({
        credentialId: t.credentialId,
        query,
        maxMessages,
        pageSize,
        updateCursor: false,
      });

      const sent = result.sentDocumentIds.length;
      const inbound = result.triageDocumentIds.length;
      totals.fetched += result.fetched;
      totals.inserted += result.inserted;
      totals.skipped += result.skipped;
      totals.ignored += result.ignored;
      totals.errors += result.errors;
      totals.sent += sent;
      totals.inbound += inbound;
      totals.chunks += result.chunksWritten;
      console.log(
        `  fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} ` +
          `ignored=${result.ignored} errors=${result.errors} sent=${sent} inbound=${inbound} ` +
          `chunks=${result.chunksWritten}`,
      );
    } catch (err) {
      // One bad credential must not stop the other mailboxes.
      totals.errors++;
      console.error(`  ! ingest failed for ${t.email}: ${toMessage(err)}`);
    }
  }

  if (COMMIT) {
    console.log(
      `\n# done — fetched=${totals.fetched} inserted=${totals.inserted} skipped=${totals.skipped} ` +
        `ignored=${totals.ignored} errors=${totals.errors} sent=${totals.sent} ` +
        `inbound=${totals.inbound} chunks=${totals.chunks}`,
    );
  } else {
    console.log(`\n# DRY — re-run with --commit to ingest across ${targets.length} credential(s)`);
  }
}

main()
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
