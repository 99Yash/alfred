import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

/**
 * Persistence layer for GitHub `integration_credentials`. Mirrors the
 * Google credentials module but simpler — classic OAuth App tokens
 * don't expire, so there is no `getFreshAccessToken`/refresh code path.
 */

export interface UpsertGithubCredentialArgs {
  userId: string;
  accountId: string;
  accountLabel?: string | null;
  accessToken: string;
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
      // Classic tokens carry no refresh; the column allows null.
      refreshToken: null,
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

/**
 * Resolve a usable access token. GitHub classic tokens don't expire so
 * this is just a fetch; we keep the function for parity with Google so
 * higher-level callers don't branch on provider.
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
