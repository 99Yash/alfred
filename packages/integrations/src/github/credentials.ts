import { getIdPath, selectGithubAccountRow, type JsonObject } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { upsertIntegrationCredential } from "../shared/credential-upsert";
import { getInstallationToken } from "./app";

/**
 * GitHub App credentials (ADR-0052). The row records the App installation and the account. A
 * connect writes no GitHub token to it: the GitHub MCP connection holds the App user grant
 * (ADR-0125), and a REST read mints a short-lived installation token, which is never stored. A
 * row from before ADR-0125 keeps its sealed user access token until the next connect overwrites it.
 * No code reads that token. It can still work when the App issues user tokens that do not expire.
 */

export interface UpsertGithubCredentialArgs {
  userId: string;
  accountId: string;
  /** The GitHub login, which the Connected card names. */
  accountLabel: string;
  /** From the post-install redirect. */
  installationId: string;
  scopes: string[];
  metadata?: JsonObject;
}

/** `access_token` is NOT NULL, so the row holds this value and never a real token. */
function githubCredentialPlaceholder(installationId: string): string {
  return `ghu_placeholder_${installationId}`;
}

export async function upsertGithubCredential(
  args: UpsertGithubCredentialArgs,
): Promise<{ id: string }> {
  return upsertIntegrationCredential(
    {
      userId: args.userId,
      provider: "github",
      accountId: args.accountId,
      accountLabel: args.accountLabel,
      // Also on a reconnect, so an old row drops the user token that it stored before.
      accessToken: githubCredentialPlaceholder(args.installationId),
      refreshToken: null,
      installationId: args.installationId,
      expiresAt: null,
      scopes: args.scopes,
      metadata: { replace: args.metadata ?? {} },
    },
    db(),
  );
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

export interface UserInstallationToken {
  token: string;
}

/** An installation token for the user's GitHub account row. The loop verifier's REST read uses it. */
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
  // shadows the account that the read will actually use.
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

  return { token };
}

/** GitHub sends a JSON number; the column is text. */
export function githubInstallationId(payload: JsonObject): string | null {
  return getIdPath(payload, "installation", "id");
}
