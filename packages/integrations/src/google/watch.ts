import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getFreshAccessToken } from "./credentials";
import { startWatch, stopWatch } from "./gmail";
import { toMessage, withDefaults } from "@alfred/contracts";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";

/**
 * Gmail push-channel bookkeeping. The watch lives in `integration_credentials.metadata.watch`
 * (at most one per credential, so no own table). The rolling cursor is in `ingestion_state`,
 * owned by the ingestion consumer.
 */

export const gmailWatchStateSchema = z.object({
  topic: z.string().min(1),
  expiresAt: z.iso.datetime(),
  /** The `historyId` from the watch call. The cold-start cursor. */
  baselineHistoryId: z.string().min(1),
  /** A renewal must not reset this: push health reads it. */
  installedAt: z.iso.datetime(),
  /** Absent on older rows. */
  renewedAt: z.iso.datetime().optional(),
});

export type GmailWatchState = z.infer<typeof gmailWatchStateSchema>;

const credentialWatchMetadataSchema = z.object({
  watch: gmailWatchStateSchema.optional(),
});

export function readGmailWatchState(metadata: unknown): GmailWatchState | null {
  const parsed = credentialWatchMetadataSchema.safeParse(metadata);

  return parsed.success && parsed.data.watch ? parsed.data.watch : null;
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
 * Install or renew a watch. `users.watch` replaces the old channel, so renewal is the same call.
 * Raw primitive: it does not seed the `ingestion_state` cursor. App code uses
 * `installGmailWatchAndSeedCursor`.
 */
export async function installGmailWatch(
  args: {
    credentialId: string;
    topicName: string;
    labelIds?: string[] | undefined;
  },
  deps: Partial<GmailWatchDeps> = {},
): Promise<GmailWatchState | null> {
  const d = withDefaults(DEFAULT_DEPS, deps);

  // Non-prod shares the real mailbox; a watch here would fight prod (#278).
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

  const now = new Date().toISOString();

  const state: GmailWatchState = {
    topic: args.topicName,
    expiresAt: watch.expiration.toISOString(),
    baselineHistoryId: watch.historyId,
    installedAt: now,
    renewedAt: now,
  };

  // Shallow jsonb merge keeps the other metadata keys.
  const [updated] = await d
    .db()
    .update(integrationCredentials)
    .set({
      // Keep the first `installedAt`, atomically against concurrent renewals.
      metadata: sql`${integrationCredentials.metadata} || jsonb_build_object('watch',
        ${JSON.stringify(state)}::jsonb || jsonb_build_object('installedAt',
          coalesce(${integrationCredentials.metadata}->'watch'->>'installedAt', ${now}::text)))`,
    })
    .where(eq(integrationCredentials.id, args.credentialId))
    .returning({ metadata: integrationCredentials.metadata });

  const saved = readGmailWatchState(updated?.metadata);

  if (!saved) throw new Error("Gmail watch metadata was not saved");

  return saved;
}

/** Stop the channel and drop the watch state. The credential stays. */
export async function uninstallGmailWatch(
  credentialId: string,
  deps: Partial<GmailWatchDeps> = {},
): Promise<void> {
  const d = withDefaults(DEFAULT_DEPS, deps);

  // Non-prod must not stop prod's watch (#278), but still clears local state.
  if (d.mailboxWritesEnabled()) {
    const accessToken = await d.getFreshAccessToken(credentialId);
    await stopGmailWatchWithAccessToken(
      { accessToken, credentialId },
      { mailboxWritesEnabled: d.mailboxWritesEnabled, stopWatch: d.stopWatch },
    );
  } else {
    console.warn(
      `[gmail.watch] remote uninstall skipped for ${credentialId}: mailbox writes disabled (non-prod)`,
    );
  }

  await d
    .db()
    .update(integrationCredentials)
    .set({
      metadata: sql`${integrationCredentials.metadata} - 'watch'`,
    })
    .where(eq(integrationCredentials.id, credentialId));
}

/** For a credential about to be deleted: stops the remote watch, leaves metadata alone. */
export async function stopGmailWatchWithAccessToken(
  args: {
    accessToken: string;
    credentialId?: string | undefined;
  },
  deps: Partial<Pick<GmailWatchDeps, "mailboxWritesEnabled" | "stopWatch">> = {},
): Promise<void> {
  const d = withDefaults(DEFAULT_DEPS, deps);

  if (!d.mailboxWritesEnabled()) {
    const suffix = args.credentialId ? ` for ${args.credentialId}` : "";
    console.warn(`[gmail.watch] stopWatch skipped${suffix}: mailbox writes disabled (non-prod)`);

    return;
  }

  try {
    await d.stopWatch({ accessToken: args.accessToken });
  } catch (err) {
    // `users.stop` returns 204 even with no channel. Do not block cleanup.
    const suffix = args.credentialId ? ` for ${args.credentialId}` : "";
    console.warn(`[gmail.watch] stopWatch failed${suffix}:`, toMessage(err));
  }
}

export async function getGmailWatchState(credentialId: string): Promise<GmailWatchState | null> {
  const rows = await db()
    .select({ metadata: integrationCredentials.metadata })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));

  const md = rows[0]?.metadata;

  return readGmailWatchState(md);
}

/** Map a Pub/Sub `emailAddress` back to a credential. */
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

/** Active watches expiring before `before`. Filters in JS after a full scan: single-user scale. */
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
    const watch = readGmailWatchState(row.metadata);

    if (!watch) continue;
    const expiresAt = new Date(watch.expiresAt);

    if (Number.isNaN(expiresAt.getTime())) continue;

    if (expiresAt > before) continue;
    out.push({ id: row.id, userId: row.userId, expiresAt, topic: watch.topic });
  }

  return out;
}
