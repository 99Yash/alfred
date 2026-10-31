import type {
  BearerSlug,
  CredentialProvider,
  InboundEventSource,
  JsonObject,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { upsertIntegrationCredential } from "./credential-upsert";

/**
 * Storage for single long-lived bearer tokens (Vercel). Tokens are
 * sealed on write and opened only where a caller needs a usable token (#453).
 *
 * Known gap: a token revoked at the provider stays `active` until a call fails.
 * Nothing marks it for reauth, so settings shows "Connected" until then.
 */

export interface UpsertBearerCredentialArgs {
  userId: string;
  provider: BearerSlug;
  /** Provider-side stable id (workspace, team, or account). */
  accountId: string;
  accountLabel?: string | null | undefined;
  accessToken: string;
  refreshToken?: string | null | undefined;
  expiresAt?: Date | null | undefined;
  scopes?: string[] | undefined;
  metadata?: JsonObject | undefined;
}

/** A reconnect of the same account updates the row in place. */
export async function upsertBearerCredential(
  args: UpsertBearerCredentialArgs,
): Promise<{ id: string }> {
  return upsertIntegrationCredential({
    userId: args.userId,
    provider: args.provider,
    accountId: args.accountId,
    accountLabel: args.accountLabel ?? null,
    accessToken: args.accessToken,
    // A blank or omitted token writes NULL, also on a reconnect.
    refreshToken: args.refreshToken || null,
    expiresAt: args.expiresAt ?? null,
    scopes: args.scopes ?? [],
    metadata: { replace: args.metadata ?? {} },
  });
}

/**
 * Returns `null` when nothing matched, so callers can 404.
 * Takes any {@link CredentialProvider}, not only {@link BearerSlug}: all providers share this table.
 */
export async function deleteIntegrationCredential(args: {
  userId: string;
  provider: CredentialProvider;
  id: string;
}): Promise<{ id: string } | null> {
  const deleted = await db()
    .delete(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.id, args.id),
        eq(integrationCredentials.userId, args.userId),
        eq(integrationCredentials.provider, args.provider),
      ),
    )
    .returning({ id: integrationCredentials.id });

  return deleted[0] ?? null;
}

export type ActiveBearerCredential = Pick<
  IntegrationCredential,
  "id" | "accountId" | "accountLabel" | "metadata"
> & {
  /** The opened token. The column holds a sealed envelope, so this type is not derived from it. */
  accessToken: string;
};

/**
 * Newest first.
 * @internal For provider clients and background callers with no ToolExecuteContext.
 */
export async function listActiveBearerCredentials(
  userId: string,
  provider: BearerSlug,
  limit = 100,
  accountRef?: string,
): Promise<ActiveBearerCredential[]> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      accessToken: integrationCredentials.accessToken,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, userId),
        eq(integrationCredentials.provider, provider),
        eq(integrationCredentials.status, "active"),
        accountRef ? eq(integrationCredentials.accountId, accountRef) : undefined,
      ),
    )
    .orderBy(desc(integrationCredentials.updatedAt))
    .limit(limit);

  const vault = credentialVault();

  return rows.map((row) => ({ ...row, accessToken: vault.open(row.accessToken) }));
}

export type CredentialOwnerRef = Pick<IntegrationCredential, "id" | "userId" | "accountId">;

const ownerRefColumns = {
  id: integrationCredentials.id,
  userId: integrationCredentials.userId,
  accountId: integrationCredentials.accountId,
};

/**
 * Sources joined by `installation_id`. Narrow, so a lookup for a provider that
 * never writes the column is a compile error.
 */
export type InstallationProvider = CredentialProvider & InboundEventSource;

/** Map a webhook's installation id to its credential. Newest active match wins. */
export async function findActiveCredentialByInstallationId(args: {
  provider: InstallationProvider;
  installationId: string;
}): Promise<CredentialOwnerRef | null> {
  const rows = await db()
    .select(ownerRefColumns)
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.provider, args.provider),
        eq(integrationCredentials.installationId, args.installationId),
        eq(integrationCredentials.status, "active"),
      ),
    )
    .orderBy(desc(integrationCredentials.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Newest active credential, or throw a connect-me error that tells the boss to ask the user.
 * @internal For provider clients and background callers with no ToolExecuteContext.
 */
export async function getActiveBearerCredential(
  userId: string,
  provider: BearerSlug,
  accountRef?: string,
): Promise<ActiveBearerCredential> {
  const rows = await listActiveBearerCredentials(userId, provider, 1, accountRef);
  const row = rows[0];

  if (!row) {
    throw new Error(
      `[${provider}.credentials] no active ${provider} credential — connect ${provider} in settings`,
    );
  }

  return row;
}
