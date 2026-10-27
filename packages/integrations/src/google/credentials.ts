import type { AccountPersona } from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { upsertIntegrationCredential } from "../shared/credential-upsert";
import { GOOGLE_EXCHANGE_METADATA_KEYS, type GoogleExchangeMetadata } from "./credential-metadata";
import { GoogleReauthRequiredError, refreshAccessToken } from "./oauth";

/**
 * Google credential storage. `getFreshAccessToken` refreshes on demand, not on a cron.
 * Tokens are sealed right before a write and opened right after a read (#453).
 */

/** Refresh when less than one minute remains. */
const REFRESH_THRESHOLD_MS = 60_000;

type DbExecutor =
  | ReturnType<typeof db>
  | Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

export interface UpsertCredentialsArgs {
  userId: string;
  accountId: string;
  accountLabel?: string | null | undefined;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  /** Replaces only the exchange-owned keys on a reconnect. */
  metadata?: GoogleExchangeMetadata | undefined;
  /** Detected from `hd`. Omit to keep the column, so a user override survives a reconnect. */
  persona?: AccountPersona | null | undefined;
}

/**
 * A reconnect of the same account updates the row in place. The conflict target includes
 * `accountId` (the Google `sub`), so a different Google account always gets its own row.
 */
export async function upsertCredential(
  args: UpsertCredentialsArgs,
  ex: DbExecutor = db(),
): Promise<{ id: string }> {
  return upsertIntegrationCredential(
    {
      userId: args.userId,
      provider: "google",
      accountId: args.accountId,
      accountLabel: args.accountLabel ?? null,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      // Same `sub`, so the same mailbox: keep the watch and label caches, replace the exchange keys.
      metadata: { ownedKeys: GOOGLE_EXCHANGE_METADATA_KEYS, values: args.metadata ?? {} },
      persona: args.persona,
    },
    ex,
  );
}

export type CredentialRow = Pick<
  IntegrationCredential,
  "id" | "userId" | "accountId" | "accountLabel" | "scopes" | "status"
>;

interface StoredCredentialRow extends CredentialRow {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
}

async function loadCredential(
  credentialId: string,
  ex: DbExecutor = db(),
  lockForUpdate = false,
): Promise<StoredCredentialRow | null> {
  const query = ex
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      accessToken: integrationCredentials.accessToken,
      refreshToken: integrationCredentials.refreshToken,
      expiresAt: integrationCredentials.expiresAt,
      scopes: integrationCredentials.scopes,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));

  const rows = lockForUpdate ? await query.for("update") : await query;
  const row = rows[0];

  if (!row) return null;

  if (!row.refreshToken) return null;
  const vault = credentialVault();

  return {
    id: row.id,
    userId: row.userId,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accessToken: vault.open(row.accessToken),
    refreshToken: vault.open(row.refreshToken),
    expiresAt: row.expiresAt,
    scopes: row.scopes,
    status: row.status,
  };
}

function requireActiveCredential(
  cred: StoredCredentialRow | null,
  credentialId: string,
): StoredCredentialRow {
  if (!cred) throw new Error(`[google.credentials] not found: ${credentialId}`);

  if (cred.status !== "active") {
    throw new Error(`[google.credentials] not active: ${credentialId} (status=${cred.status})`);
  }

  return cred;
}

function isExpiringSoon(cred: StoredCredentialRow): boolean {
  return !cred.expiresAt || cred.expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
}

type RefreshResolution =
  | { kind: "token"; accessToken: string }
  | { kind: "reauth"; error: GoogleReauthRequiredError };

/**
 * A usable token, refreshed when near expiry. Throws when the row is gone or not active.
 * @internal For provider clients and background callers with no ToolExecuteContext.
 */
export async function getFreshAccessToken(credentialId: string): Promise<string> {
  const current = requireActiveCredential(await loadCredential(credentialId), credentialId);

  if (!isExpiringSoon(current)) return current.accessToken;

  const resolution = await db().transaction(async (tx): Promise<RefreshResolution> => {
    // Lock and re-read so only one worker calls Google; the others use its token.
    const cred = requireActiveCredential(
      await loadCredential(credentialId, tx, true),
      credentialId,
    );

    if (!isExpiringSoon(cred)) return { kind: "token", accessToken: cred.accessToken };

    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;

    try {
      refreshed = await refreshAccessToken(cred.refreshToken);
    } catch (err) {
      if (err instanceof GoogleReauthRequiredError) {
        // Leave "active" so `findCredentialsNeedingPoll` stops retrying and the UI asks to reconnect.
        await tx
          .update(integrationCredentials)
          .set({ status: "needs_reauth" })
          .where(eq(integrationCredentials.id, credentialId));

        // Return, not throw, so the status change commits.
        return { kind: "reauth", error: err };
      }

      throw err;
    }

    await tx
      .update(integrationCredentials)
      .set({
        accessToken: credentialVault().seal(refreshed.accessToken),
        refreshToken: credentialVault().seal(refreshed.refreshToken ?? cred.refreshToken),
        expiresAt: refreshed.expiresAt,
        // Google sometimes omits scopes on refresh.
        scopes: refreshed.scopes.length ? refreshed.scopes : cred.scopes,
        lastRefreshedAt: new Date(),
      })
      .where(eq(integrationCredentials.id, credentialId));

    return { kind: "token", accessToken: refreshed.accessToken };
  });

  if (resolution.kind === "reauth") throw resolution.error;

  return resolution.accessToken;
}

export async function listCredentials(
  userId: string,
  provider?: "google",
): Promise<CredentialRow[]> {
  const where = provider
    ? and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider))
    : eq(integrationCredentials.userId, userId);

  // Test presence in SQL so no ciphertext leaves Postgres.
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      scopes: integrationCredentials.scopes,
      status: integrationCredentials.status,
      hasRefreshToken: sql<boolean>`${integrationCredentials.refreshToken} IS NOT NULL`,
    })
    .from(integrationCredentials)
    .where(where);

  return rows
    .filter((r) => r.hasRefreshToken)
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      accountId: r.accountId,
      accountLabel: r.accountLabel,
      scopes: r.scopes,
      status: r.status,
    }));
}
