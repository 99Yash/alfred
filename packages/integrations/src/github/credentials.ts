import { db } from "@alfred/db";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { getInstallationToken } from "./app";

/**
 * Persistence layer for GitHub `integration_credentials` (ADR-0052, GitHub
 * App). The stored `access_token` is the user-to-server *identity* token;
 * live REST access goes through short-lived installation tokens minted from
 * `installation_id` (see `getInstallationTokenForUser`).
 */

export interface UpsertGithubCredentialArgs {
  userId: string;
  accountId: string;
  accountLabel?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  /** GitHub App installation id captured on the post-install redirect. */
  installationId?: string | null;
  scopes: string[];
  metadata?: Record<string, unknown>;
  expiresAt: Date;
}

export async function upsertGithubCredential(
  args: UpsertGithubCredentialArgs,
): Promise<{ id: string }> {
  const result = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: "github",
      accountId: args.accountId,
      accountLabel: args.accountLabel ?? null,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken ?? null,
      installationId: args.installationId ?? null,
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
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? null,
        installationId: args.installationId ?? null,
        expiresAt: args.expiresAt,
        scopes: args.scopes,
        metadata: args.metadata ?? {},
        status: "active",
        accountLabel: args.accountLabel ?? null,
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
 * List a user's GitHub credential rows (parity with Google's
 * `listCredentials(userId, "google")`). Tool code finds the active one and
 * resolves its token. Most users have exactly one.
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
    );
}

/**
 * Resolve the stored user-to-server identity token for a credential row.
 * Kept for parity with Google; most callers want `getInstallationTokenForUser`
 * for actual REST access.
 */
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
  return row.accessToken;
}

export interface UserInstallationToken {
  token: string;
  accountLogin: string | null;
}

/**
 * Mint a short-lived installation token for a user's active GitHub App
 * connection — the token REST calls (PR search, issues) actually use. Also
 * returns the connected login so callers can resolve `author:@me`.
 */
export async function getInstallationTokenForUser(userId: string): Promise<UserInstallationToken> {
  const active = (await listGithubCredentials(userId)).find((c) => c.status === "active");
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

/**
 * Resolve the user that owns a GitHub App installation — the join from an
 * inbound webhook delivery (which carries only `installation.id`) back to a
 * user. Returns the most-recently-updated active match.
 */
export async function findUserByInstallationId(installationId: string): Promise<string | null> {
  const rows = await db()
    .select({ userId: integrationCredentials.userId })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.provider, "github"),
        eq(integrationCredentials.installationId, installationId),
        eq(integrationCredentials.status, "active"),
      ),
    )
    .orderBy(desc(integrationCredentials.updatedAt))
    .limit(1);
  return rows[0]?.userId ?? null;
}
