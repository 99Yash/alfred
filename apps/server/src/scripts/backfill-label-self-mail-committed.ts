/**
 * COMMITTED self-mail label backfill (issue #285).
 *
 * Going forward, the ingestor tags Alfred's own briefing / HIL-approval mail with
 * the dedicated `Alfred` Gmail label on the same drop path that keeps it out of
 * triage (`labelSelfAuthoredMail`, wired into `persistMessage`). This script does
 * the one-off catch-up for self-mail that already landed BEFORE that shipped:
 * those messages were dropped from `documents` (#211/#266) so there is nothing in
 * the DB to drive from — we go straight to Gmail.
 *
 * Per Gmail-capable credential:
 *   1. Ensure the `Alfred` label exists (`ensureAlfredSelfLabel` → id + cache).
 *   2. `messages.list` for self-authored mail that isn't already labelled:
 *        from:(<self addrs>) -label:"Alfred"
 *      The `from:` operator matches the actual sender header (not body quotes),
 *      so — unlike the DESTRUCTIVE retire backfills — no second exact-address
 *      pass is needed here: applying a label is reversible, and the `-label:`
 *      clause makes re-runs cheap + idempotent (already-tagged mail never
 *      re-lists).
 *   3. `batchModify` (≤1000 ids/call) to add the label.
 *
 * The self-address set mirrors the retire backfills: the CURRENT `RESEND_FROM_EMAIL`
 * ∪ historical send-from aliases (`--aliases`, default `yash@croisillies.xyz`), so
 * briefings from the old envelope get organised too.
 *
 * This ONLY adds a label — it never writes `documents`, `email_triage`, or a
 * sender prior, so the #211/#266 self-loop stays closed.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfill-label-self-mail-committed.js`.
 *
 * SAFETY: dry by default — lists the candidate count per credential and writes
 * NOTHING. `--commit` ensures the label and applies it.
 *
 *   # preview personal mailbox (writes no labels):
 *   node dist/scripts/backfill-label-self-mail-committed.js --emails=yashgouravkar@gmail.com
 *   # commit across the given user(s):
 *   node dist/scripts/backfill-label-self-mail-committed.js --emails=yashgouravkar@gmail.com,yash.k@oliv.ai --commit
 *   # every connected Google account, extra alias:
 *   node dist/scripts/backfill-label-self-mail-committed.js --all-connected --aliases=old@x.com --commit
 */
import { closeConnections, closeRedis, warmPool } from "@alfred/api";
import { parseEmailAddress, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user as userTable } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  ALFRED_SELF_LABEL_NAME,
  batchModifyMessages,
  ensureAlfredSelfLabel,
  GMAIL_MODIFY_SCOPE,
  getFreshAccessToken,
  listMessages,
  selfSenderEmail,
} from "@alfred/integrations/google";
import { and, eq, inArray } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const ALL_CONNECTED = process.argv.includes("--all-connected");
const DEFAULT_MAX_MESSAGES = 5000;
const GMAIL_PAGE_SIZE = 100;
const GMAIL_BATCH_MODIFY_CAP = 1000;

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseListFlag(name: string, fallback: string): string[] {
  const raw = flagValue(name) ?? fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

/**
 * Build the self-address set: the current send address ∪ historical aliases,
 * each run through the same parser the runtime guard (`isSelfAuthored`) uses.
 */
function resolveSelfAddresses(): string[] {
  const addrs = new Set<string>();
  const current = selfSenderEmail();
  if (current) addrs.add(current);
  const unparsed: string[] = [];
  for (const a of parseListFlag("aliases", "yash@croisillies.xyz")) {
    const parsed = parseEmailAddress(a);
    if (parsed) addrs.add(parsed);
    else unparsed.push(a);
  }
  if (unparsed.length) console.log(`! ignored unparseable alias(es): ${unparsed.join(", ")}`);
  return [...addrs];
}

/** `from:(a OR b) -label:"Alfred"` — self-authored mail not already tagged. */
function buildQuery(selfAddrs: string[]): string {
  const from = `from:(${selfAddrs.join(" OR ")})`;
  return `${from} -label:"${ALFRED_SELF_LABEL_NAME}"`;
}

interface TargetCredential {
  credentialId: string;
  userId: string;
  email: string;
  accountLabel: string | null;
}

/** Label creation + batchModify require a Gmail mutation grant. */
function hasGmailModifyScope(scopes: string[]): boolean {
  return scopes.includes(GMAIL_MODIFY_SCOPE);
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
    if (!hasGmailModifyScope(scopes)) {
      console.log(`! skipping credential=${r.credentialId} (${r.email}) — no gmail.modify scope`);
      continue;
    }
    targets.push({
      credentialId: r.credentialId,
      userId: r.userId,
      email: r.email,
      accountLabel: r.accountLabel,
    });
  }
  return targets;
}

/** List candidate self-mail message ids (read-only) up to the cap. */
async function listCandidateIds(
  accessToken: string,
  query: string,
  maxMessages: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < maxMessages) {
    const page = await listMessages({
      accessToken,
      q: query,
      maxResults: Math.min(GMAIL_PAGE_SIZE, maxMessages - ids.length),
      pageToken,
    });
    ids.push(...page.messages.map((m) => m.id));
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return ids;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function processCredential(
  t: TargetCredential,
  selfAddrs: string[],
  maxMessages: number,
): Promise<number> {
  console.log(
    `\n=== ${t.email}${t.accountLabel ? ` (${t.accountLabel})` : ""} (credential=${t.credentialId}) ===`,
  );
  const accessToken = await getFreshAccessToken(t.credentialId);
  const query = buildQuery(selfAddrs);
  const ids = await listCandidateIds(accessToken, query, maxMessages);
  console.log(`  ${ids.length} unlabelled self-mail message(s) match (cap ${maxMessages})`);

  if (ids.length === 0) return 0;

  if (!COMMIT) {
    console.log(
      `  DRY — would ensure label "${ALFRED_SELF_LABEL_NAME}" and add it to ${ids.length} message(s)`,
    );
    return 0;
  }

  const labelId = await ensureAlfredSelfLabel(t.credentialId, { accessToken });
  let labelled = 0;
  for (const batch of chunk(ids, GMAIL_BATCH_MODIFY_CAP)) {
    await batchModifyMessages({ accessToken, messageIds: batch, addLabelIds: [labelId] });
    labelled += batch.length;
  }
  console.log(`  PERSISTED — added "${ALFRED_SELF_LABEL_NAME}" to ${labelled} message(s)`);
  return labelled;
}

async function main() {
  if (COMMIT && !gmailMailboxWritesEnabled()) {
    throw new Error(
      "[backfill-label-self-mail] refuses to mutate Gmail while mailbox writes are disabled; set GMAIL_MAILBOX_WRITES_ENABLED=true for a committed backfill",
    );
  }

  const emails = parseListFlag("emails", "");
  if (!ALL_CONNECTED && emails.length === 0) {
    throw new Error("specify --emails=a@x.com,b@y.com or --all-connected");
  }
  const maxMessages = parsePositiveInt("max-messages", DEFAULT_MAX_MESSAGES);
  const selfAddrs = resolveSelfAddresses();
  if (selfAddrs.length === 0) {
    throw new Error("no self addresses to match (RESEND_FROM_EMAIL unparseable and no aliases)");
  }

  await warmPool();

  console.log(
    `# Self-mail label backfill — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `self-set={${selfAddrs.join(", ")}} | label="${ALFRED_SELF_LABEL_NAME}" | ` +
      `maxMessages=${maxMessages} | target=${ALL_CONNECTED ? "all-connected" : emails.join(", ")}`,
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

  let total = 0;
  for (const t of targets) {
    try {
      total += await processCredential(t, selfAddrs, maxMessages);
    } catch (err) {
      // One bad credential (revoked token, missing scope) must not abort the
      // remaining mailboxes in an --all-connected sweep.
      console.error(`  ! failed for ${t.email}: ${toMessage(err)}`);
    }
  }

  console.log(
    COMMIT
      ? `\n# done — labelled ${total} message(s) across ${targets.length} credential(s)`
      : `\n# DRY — re-run with --commit to label across ${targets.length} credential(s)`,
  );
}

main()
  .catch((e) => {
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
