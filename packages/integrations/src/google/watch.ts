import { db } from "@alfred/db";
import { ingestionState, integrationCredentials } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { getFreshAccessToken } from "./credentials";
import { startWatch, stopWatch } from "./gmail";
import { toMessage } from "@alfred/contracts";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";

/**
 * Push-channel lifecycle for Gmail. The actual delta sync is in
 * `ingestor.ts`; this module is just the watch + cursor bookkeeping.
 *
 * State is split across two tables:
 *  - `integration_credentials.metadata.watch`: channel-level bookkeeping
 *    (Pub/Sub topic + expiration + the historyId Gmail returned at watch
 *    time, kept as the cold-start baseline).
 *  - `ingestion_state.state.historyId`: rolling cursor — advanced by
 *    every successful poll/webhook delta. The watch baseline only seeds
 *    this row on first connect.
 *
 * Rationale for not adding a dedicated `gmail_watches` table: at most one
 * watch per credential, and watch state is irrelevant outside this
 * provider — the jsonb shape keeps the schema diff to zero.
 */

export interface GmailWatchState {
  topic: string;
  /** ISO timestamp; convert with `new Date(...)`. */
  expiresAt: string;
  /** The `historyId` Gmail returned at watch creation. Cold-start cursor. */
  baselineHistoryId: string;
  /** When we last installed/renewed this watch (audit). */
  installedAt: string;
}

interface CredentialMetadataWithWatch {
  watch?: GmailWatchState;
  [key: string]: unknown;
}

interface GmailWatchDeps {
  mailboxWritesEnabled: typeof gmailMailboxWritesEnabled;
  getFreshAccessToken: typeof getFreshAccessToken;
  startWatch: typeof startWatch;
  stopWatch: typeof stopWatch;
  db: typeof db;
}

const DEFAULT_DEPS: GmailWatchDeps = {
  mailboxWritesEnabled: gmailMailboxWritesEnabled,
  getFreshAccessToken,
  startWatch,
  stopWatch,
  db,
};

/**
 * Install or renew a Gmail watch channel for a credential.
 *
 * Idempotent against Gmail: re-calling `users.watch` for the same user
 * replaces the existing channel, so a renewal is just another call. We
 * always re-run startWatch and overwrite the stored state — Gmail's
 * historyId from the latest call is the correct baseline.
 */
export async function installGmailWatch(
  args: {
    credentialId: string;
    topicName: string;
    labelIds?: string[];
  },
  deps: Partial<GmailWatchDeps> = {},
): Promise<GmailWatchState | null> {
  const d = { ...DEFAULT_DEPS, ...deps };
  // #278: a non-prod instance must not register a watch against the shared real
  // Gmail account — it would drive ingestion + relabel that fights prod. Returns
  // null (not a fake state) so callers can report "skipped" honestly.
  if (!d.mailboxWritesEnabled()) {
    console.warn(
      `[gmail.watch] install skipped for ${args.credentialId}: mailbox writes disabled (non-prod)`,
    );
    return null;
  }
  const accessToken = await d.getFreshAccessToken(args.credentialId);
  const watch = await d.startWatch({
    accessToken,
    topicName: args.topicName,
    labelIds: args.labelIds,
  });

  const state: GmailWatchState = {
    topic: args.topicName,
    expiresAt: watch.expiration.toISOString(),
    baselineHistoryId: watch.historyId,
    installedAt: new Date().toISOString(),
  };

  // Merge into existing metadata jsonb so we don't clobber `token_type`
  // and other unrelated keys. Drizzle's `||` operator on jsonb merges
  // shallowly which is exactly what we want here.
  await d
    .db()
    .update(integrationCredentials)
    .set({
      metadata: sql`${integrationCredentials.metadata} || ${JSON.stringify({ watch: state })}::jsonb`,
    })
    .where(eq(integrationCredentials.id, args.credentialId));

  // Seed the rolling cursor only when no prior cursor exists — a renewal
  // must not reset the cursor or we'd skip everything between the last
  // poll and now.
  await seedHistoryCursorIfAbsent({
    credentialId: args.credentialId,
    historyId: watch.historyId,
  });

  return state;
}

/**
 * Stop the channel + drop the stored watch state. Keeps the credential
 * row itself intact — disconnect-from-watch is not the same as
 * disconnect-from-google.
 */
export async function uninstallGmailWatch(credentialId: string): Promise<void> {
  const d = DEFAULT_DEPS;
  // #278: never stop a watch from non-prod — the only live watch belongs to
  // prod, and stopping it here would kill prod ingestion.
  if (!d.mailboxWritesEnabled()) {
    console.warn(
      `[gmail.watch] uninstall skipped for ${credentialId}: mailbox writes disabled (non-prod)`,
    );
    return;
  }
  const accessToken = await d.getFreshAccessToken(credentialId);
  await stopGmailWatchWithAccessToken({ accessToken, credentialId });
  await d
    .db()
    .update(integrationCredentials)
    .set({
      metadata: sql`${integrationCredentials.metadata} - 'watch'`,
    })
    .where(eq(integrationCredentials.id, credentialId));
}

/**
 * Stop Gmail's remote watch when the credential row is about to disappear.
 * Unlike `uninstallGmailWatch`, this does not update local metadata, so callers
 * can run it after the credential delete commits without reloading the row.
 */
export async function stopGmailWatchWithAccessToken(
  args: {
    accessToken: string;
    credentialId?: string;
  },
  deps: Partial<Pick<GmailWatchDeps, "mailboxWritesEnabled" | "stopWatch">> = {},
): Promise<void> {
  const d = { ...DEFAULT_DEPS, ...deps };
  // #278: don't stop the shared watch from non-prod (would kill prod ingestion).
  if (!d.mailboxWritesEnabled()) {
    const suffix = args.credentialId ? ` for ${args.credentialId}` : "";
    console.warn(`[gmail.watch] stopWatch skipped${suffix}: mailbox writes disabled (non-prod)`);
    return;
  }
  try {
    await d.stopWatch({ accessToken: args.accessToken });
  } catch (err) {
    // `users.stop` returns 204 even when no active channel exists, so
    // a non-2xx here is unusual — surface but don't block state cleanup.
    const suffix = args.credentialId ? ` for ${args.credentialId}` : "";
    console.warn(`[gmail.watch] stopWatch failed${suffix}:`, toMessage(err));
  }
}

export async function getGmailWatchState(credentialId: string): Promise<GmailWatchState | null> {
  const rows = await db()
    .select({ metadata: integrationCredentials.metadata })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const md = rows[0]?.metadata as CredentialMetadataWithWatch | undefined;
  return md?.watch ?? null;
}

/**
 * Look up the email address (account label) for a credential, used by
 * the webhook to map a Pub/Sub `emailAddress` payload back to a row.
 */
export async function findCredentialByEmail(
  emailAddress: string,
): Promise<{ id: string; userId: string } | null> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.accountLabel, emailAddress),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find Gmail credentials whose watch channel is expiring soon (or
 * already expired). The renewal cron drains this list. Single-user
 * scale = JS-side filtering after a full scan; if this ever grows we'd
 * add a generated column + index.
 */
export async function findExpiringGmailWatches(
  before: Date,
): Promise<{ id: string; userId: string; expiresAt: Date; topic: string }[]> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      metadata: integrationCredentials.metadata,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "google"));
  const out: { id: string; userId: string; expiresAt: Date; topic: string }[] = [];
  for (const row of rows) {
    if (row.status !== "active") continue;
    const md = row.metadata as CredentialMetadataWithWatch | null;
    const watch = md?.watch;
    if (!watch) continue;
    const expiresAt = new Date(watch.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) continue;
    if (expiresAt > before) continue;
    out.push({ id: row.id, userId: row.userId, expiresAt, topic: watch.topic });
  }
  return out;
}

async function seedHistoryCursorIfAbsent(args: {
  credentialId: string;
  historyId: string;
}): Promise<void> {
  const existing = await db()
    .select({ id: ingestionState.id })
    .from(ingestionState)
    .where(
      and(
        eq(ingestionState.credentialId, args.credentialId),
        eq(ingestionState.stream, "messages"),
      ),
    );
  if (existing[0]) return;

  // No prior cursor → seed one. Look up userId from the credential row;
  // we need it for the not-null FK.
  const credRow = (
    await db()
      .select({ userId: integrationCredentials.userId })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, args.credentialId))
  )[0];
  if (!credRow) {
    throw new Error(`[gmail.watch] credential vanished mid-install: ${args.credentialId}`);
  }
  await db()
    .insert(ingestionState)
    .values({
      credentialId: args.credentialId,
      userId: credRow.userId,
      provider: "google",
      stream: "messages",
      state: { historyId: args.historyId },
      lastSyncAt: null,
      lastFullSyncAt: null,
    })
    .onConflictDoNothing({
      target: [ingestionState.credentialId, ingestionState.stream],
    });
}
