/**
 * COMMITTED Gmail sent / lifetime backfill (user-model P1, issue #218 — PR B).
 *
 * The user-model significance fold needs reciprocity + reply-latency signal,
 * and that requires the user's OUTBOUND mail. Steady-state ingestion only keeps
 * a rolling `newer_than:30d` window (plus realtime), so the deep sent history
 * the fold wants isn't on file. This script fills it: it drives the existing
 * full Gmail ingest path (`ingestRecentGmail`) over a sent-scoped query so the
 * messages land as ordinary `documents` rows the P1 reducer can later replay.
 *
 * Why call `ingestRecentGmail` directly (not via the ingestion queue): the
 * queue's `gmail.ingest_recent` job adds post-insert side effects (triage
 * fan-out, thread reconcile, label reconcile). We want NONE of those for a bulk
 * backfill — this is the `triageInsertedDocs: false` contract, achieved by not
 * running the post-insert plan at all. `ingestRecentGmail` only READS Gmail
 * (list + get) and WRITES `documents` + chunks; this script opts out of the
 * ingestor's normal history-cursor update because a filtered sent-mail replay
 * is not a full mailbox sync. It never mutates the mailbox or emits a triage
 * event, so the #278 mailbox-write gate is not in play.
 *
 *   - Sent docs persist with `metadata.isSent = true` (set by `persistMessage`).
 *   - Alfred's own outbound (`From = RESEND_FROM_EMAIL`) is dropped by the
 *     existing `isSelfAuthored` guard (#211) — and `in:sent` on the user's
 *     mailbox never contains it anyway (Resend doesn't write the Sent folder).
 *   - Re-runs are idempotent: the `(user_id, source, source_id)` unique index
 *     makes already-ingested messages a `skipped` no-op.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfills/backfill-gmail-sent-committed.js` — the prod image has no
 * `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default — lists the candidate message ids per credential and
 * writes NOTHING. `--commit` is required to actually ingest (which also calls
 * Gmail `get` per message + embeds, so it is not free).
 *
 *   # preview personal mailbox (writes nothing):
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --emails=yashgouravkar@gmail.com
 *   # commit, last 365d of sent mail:
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --emails=yashgouravkar@gmail.com --newer-than=365d --commit
 *   # every connected Google account, full custom query:
 *   node dist/scripts/backfills/backfill-gmail-sent-committed.js --all-connected --query="in:sent" --commit
 */
import { warmPool } from "@alfred/api/runtime";
import { closeScriptResources } from "../script-runtime";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user as userTable } from "@alfred/db/schemas";
import { getFreshAccessToken, ingestRecentGmail, listMessages } from "@alfred/integrations/google";
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

/**
 * The Gmail search query to ingest. A `--query` overrides everything (use it to
 * pull inbound + sent or any custom slice); otherwise we scope to sent mail
 * with the requested recency horizon. The horizon is a script argument, not an
 * architecture constant — the P1 fold doesn't care how far back we filled.
 */
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

/** A Google credential is Gmail-capable iff it was granted a gmail.* scope. */
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
    const scopes = (r.scopes as string[] | null) ?? [];
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

/** Dry-run: list candidate message ids (read-only) up to the cap. */
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
      // One bad credential (revoked token, missing scope) must not abort the
      // remaining mailboxes in an --all-connected sweep.
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
