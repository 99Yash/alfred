import type { AccountPersona } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { GoogleReauthRequiredError, refreshAccessToken } from "./oauth";

/**
 * Persistence + freshness layer for Google `integration_credentials`.
 * Callers ask for an access token via `getFreshAccessToken(credentialId)`
 * and don't worry about expiry — this module refreshes on demand and
 * writes the new token back atomically.
 *
 * Refresh-on-demand (vs background cron) keeps the implementation small
 * at single-user scale; a missed cron tick won't bury a request.
 */

/** Refresh when fewer than this many seconds remain on the token. */
const REFRESH_THRESHOLD_MS = 60_000;

export interface UpsertCredentialsArgs {
  userId: string;
  provider: "google";
  accountId: string;
  accountLabel?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  metadata?: Record<string, unknown>;
  /**
   * Account persona (ADR-0051 #3): `'work' | 'personal'`, auto-detected from
   * the Google `hd` claim at connect. Omitted leaves the column untouched on
   * update so a user override survives a token re-connect.
   */
  persona?: AccountPersona | null;
}

/**
 * Insert or update the credential row for `(user, provider, account)`.
 * The unique index makes this a clean upsert: re-connecting the same
 * Google account replaces the row in place rather than creating a
 * duplicate.
 */
export async function upsertCredential(args: UpsertCredentialsArgs): Promise<{ id: string }> {
  const updateSet: Record<string, unknown> = {
    accessToken: args.accessToken,
    // A re-connect issues a new refresh token; honour it.
    refreshToken: args.refreshToken,
    expiresAt: args.expiresAt,
    scopes: args.scopes,
    metadata: args.metadata ?? {},
    status: "active",
    accountLabel: args.accountLabel ?? null,
    lastRefreshedAt: new Date(),
    updatedAt: new Date(),
  };
  // Persona: fill only when currently NULL, so a re-connect (which re-detects
  // from `hd`) never clobbers a user override (ADR-0051 #3).
  if (args.persona !== undefined) {
    updateSet.persona = sql`COALESCE(${integrationCredentials.persona}, ${args.persona ?? null})`;
  }

  const result = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: args.provider,
      accountId: args.accountId,
      accountLabel: args.accountLabel ?? null,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      metadata: args.metadata ?? {},
      status: "active",
      persona: args.persona ?? null,
    })
    .onConflictDoUpdate({
      target: [
        integrationCredentials.userId,
        integrationCredentials.provider,
        integrationCredentials.accountId,
      ],
      set: updateSet,
    })
    .returning({ id: integrationCredentials.id });
  const row = result[0];
  if (!row) throw new Error("[google.credentials] upsert returned no row");
  return { id: row.id };
}

export interface CredentialRow {
  id: string;
  userId: string;
  accountId: string;
  accountLabel: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  scopes: string[];
  status: string;
}

async function loadCredential(credentialId: string): Promise<CredentialRow | null> {
  const rows = await db()
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const row = rows[0];
  if (!row) return null;
  if (!row.refreshToken) return null;
  return {
    id: row.id,
    userId: row.userId,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scopes: (row.scopes as string[] | null) ?? [],
    status: row.status,
  };
}

/**
 * Resolve a usable access token for a credential. Refreshes when within
 * the threshold of expiry. Throws when the row is gone or revoked — the
 * caller treats that as "ask the user to re-connect."
 */
export async function getFreshAccessToken(credentialId: string): Promise<string> {
  const cred = await loadCredential(credentialId);
  if (!cred) throw new Error(`[google.credentials] not found: ${credentialId}`);
  if (cred.status !== "active") {
    throw new Error(`[google.credentials] not active: ${credentialId} (status=${cred.status})`);
  }
  const expiringSoon =
    !cred.expiresAt || cred.expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
  if (!expiringSoon) return cred.accessToken;

  let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshed = await refreshAccessToken(cred.refreshToken);
  } catch (err) {
    if (err instanceof GoogleReauthRequiredError) {
      // A dead refresh token fails on every poll. Flip the credential out of
      // "active" so `findCredentialsNeedingPoll` stops re-enqueuing the same
      // doomed job each sweep (the silent 5-min failure loop that took Gmail
      // ingestion dark for 36h), and the UI can surface a reconnect prompt.
      await db()
        .update(integrationCredentials)
        .set({ status: "needs_reauth" })
        .where(eq(integrationCredentials.id, credentialId));
    }
    throw err;
  }
  await db()
    .update(integrationCredentials)
    .set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? cred.refreshToken,
      expiresAt: refreshed.expiresAt,
      // Don't overwrite scopes from refresh — Google sometimes omits them.
      scopes: refreshed.scopes.length ? refreshed.scopes : cred.scopes,
      lastRefreshedAt: new Date(),
    })
    .where(eq(integrationCredentials.id, credentialId));
  return refreshed.accessToken;
}

export async function listCredentials(
  userId: string,
  provider?: "google",
): Promise<CredentialRow[]> {
  const where = provider
    ? and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider))
    : eq(integrationCredentials.userId, userId);
  const rows = await db().select().from(integrationCredentials).where(where);
  return rows
    .filter((r) => r.refreshToken !== null)
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      accountId: r.accountId,
      accountLabel: r.accountLabel,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken!,
      expiresAt: r.expiresAt,
      scopes: (r.scopes as string[] | null) ?? [],
      status: r.status,
    }));
}
