import { getIdPath, selectGithubAccountRow, type JsonObject } from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { getInstallationToken } from "./app";

/**
 * GitHub App credentials (ADR-0052). The stored token is the user identity token.
 * REST calls use short-lived installation tokens, which are never stored.
 */

export interface UpsertGithubCredentialArgs {
  userId: string;
  accountId: string;
  /** The GitHub login. Blank would leave `@me` unresolvable, so every row has one. */
  accountLabel: string;
  accessToken: string;
  refreshToken?: string | null;
  /** From the post-install redirect. */
  installationId: string;
  scopes: string[];
  metadata?: JsonObject;
  expiresAt: Date;
}

export async function upsertGithubCredential(
  args: UpsertGithubCredentialArgs,
): Promise<{ id: string }> {
  const vault = credentialVault();
  const sealedAccessToken = vault.seal(args.accessToken);
  const sealedRefreshToken = args.refreshToken ? vault.seal(args.refreshToken) : null;

  const result = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: "github",
      accountId: args.accountId,
      accountLabel: args.accountLabel,
      accessToken: sealedAccessToken,
      refreshToken: sealedRefreshToken,
      installationId: args.installationId,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      metadata: args.metadata ?? {},
      status: "active",
    })
    .onConflictDoUpdate({
      target: [
        integrationCredentials.userId,
        integrationCredentials.provider,
        integrationCredentials.accountId,
      ],
      set: {
        accessToken: sealedAccessToken,
        refreshToken: sealedRefreshToken,
        installationId: args.installationId,
        expiresAt: args.expiresAt,
        scopes: args.scopes,
        metadata: args.metadata ?? {},
        status: "active",
        accountLabel: args.accountLabel,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({ id: integrationCredentials.id });

  const row = result[0];

  if (!row) throw new Error("[github.credentials] upsert returned no row");

  return { id: row.id };
}

export type GithubCredentialSummary = Pick<
  IntegrationCredential,
  "id" | "status" | "accountId" | "accountLabel" | "installationId"
>;

/**
 * Oldest first, so "the first row" is the first connected account for every reader.
 * `selectGithubAccountRow` picks from this order, so the Connected card and the token
 * path name the same account.
 */
export async function listGithubCredentials(userId: string): Promise<GithubCredentialSummary[]> {
  return db()
    .select({
      id: integrationCredentials.id,
      status: integrationCredentials.status,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      installationId: integrationCredentials.installationId,
    })
    .from(integrationCredentials)
    .where(
      and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, "github")),
    )
    .orderBy(asc(integrationCredentials.createdAt), asc(integrationCredentials.id));
}

/** The stored identity token. For REST access use `getInstallationTokenForUser`. */
export async function getGithubAccessToken(credentialId: string): Promise<string> {
  const rows = await db()
    .select({
      accessToken: integrationCredentials.accessToken,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));

  const row = rows[0];

  if (!row) throw new Error(`[github.credentials] not found: ${credentialId}`);

  if (row.status !== "active") {
    throw new Error(`[github.credentials] not active: ${credentialId} (status=${row.status})`);
  }

  return credentialVault().open(row.accessToken);
}

export interface UserInstallationToken {
  token: string;
  accountLogin: string | null;
}

/** Also returns the login, for resolving `author:@me`. */
export async function getInstallationTokenForUser(
  userId: string,
  accountRef?: string,
): Promise<UserInstallationToken> {
  const candidates = (await listGithubCredentials(userId)).filter(
    (credential) =>
      credential.status === "active" &&
      (accountRef === undefined || credential.accountId === accountRef),
  );

  // The one rule both this and the availability card read, so a partial row never
  // shadows the account the tools will actually use.
  const active = selectGithubAccountRow(candidates);

  if (!active) {
    throw new Error(
      `[github.credentials] user ${userId} has no active github credential — connect GitHub in settings`,
    );
  }

  if (!active.installationId) {
    throw new Error(
      `[github.credentials] user ${userId} github credential has no installation_id — reconnect GitHub (the App must be installed)`,
    );
  }

  const { token } = await getInstallationToken(active.installationId);

  return { token, accountLogin: active.accountLabel?.trim() || null };
}

/** GitHub sends a JSON number; the column is text. */
export function githubInstallationId(payload: JsonObject): string | null {
  return getIdPath(payload, "installation", "id");
}
