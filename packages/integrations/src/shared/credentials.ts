import { db } from "@alfred/db";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

/**
 * Shared persistence layer for providers whose access is a single long-lived
 * bearer token — Notion (OAuth, non-expiring access token), Vercel (OAuth,
 * non-expiring), and Railway (a pasted account API token). None of them need
 * Google's refresh-on-demand machinery, so the whole layer is "store one
 * bearer token, read it back." Google and GitHub keep their bespoke modules
 * (refresh rotation / installation-token minting); this is the third pattern.
 */

export interface UpsertBearerCredentialArgs {
  userId: string;
  /** `integration_credentials.provider` — e.g. `'notion'`, `'railway'`, `'vercel'`. */
  provider: string;
  /** Provider-side stable id (workspace id, team/user id, account id). */
  accountId: string;
  accountLabel?: string | null;
  accessToken: string;
  /** Most bearer providers issue none; kept for parity with the column. */
  refreshToken?: string | null;
  /** Null for non-expiring tokens (the common case here). */
  expiresAt?: Date | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Insert or replace the credential row for `(user, provider, account)`. The
 * unique index makes a re-connect of the same account a clean in-place update
 * rather than a duplicate, exactly like the Google/GitHub upserts.
 */
export async function upsertBearerCredential(
  args: UpsertBearerCredentialArgs,
): Promise<{ id: string }> {
  const result = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: args.provider,
      accountId: args.accountId,
      accountLabel: args.accountLabel ?? null,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken ?? null,
      expiresAt: args.expiresAt ?? null,
      scopes: args.scopes ?? [],
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
        expiresAt: args.expiresAt ?? null,
        scopes: args.scopes ?? [],
        metadata: args.metadata ?? {},
        status: "active",
        accountLabel: args.accountLabel ?? null,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({ id: integrationCredentials.id });
  const row = result[0];
  if (!row) throw new Error(`[${args.provider}.credentials] upsert returned no row`);
  return { id: row.id };
}

export type BearerCredentialSummary = Pick<
  IntegrationCredential,
  | "id"
  | "status"
  | "accountId"
  | "accountLabel"
  | "scopes"
  | "expiresAt"
  | "createdAt"
  | "lastRefreshedAt"
>;

/** List a user's credential rows for a bearer-token provider (UI status + management). */
export async function listBearerCredentials(
  userId: string,
  provider: string,
): Promise<BearerCredentialSummary[]> {
  return db()
    .select({
      id: integrationCredentials.id,
      status: integrationCredentials.status,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      scopes: integrationCredentials.scopes,
      expiresAt: integrationCredentials.expiresAt,
      createdAt: integrationCredentials.createdAt,
      lastRefreshedAt: integrationCredentials.lastRefreshedAt,
    })
    .from(integrationCredentials)
    .where(
      and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider)),
    )
    .orderBy(desc(integrationCredentials.createdAt))
    .limit(100);
}

export interface ActiveBearerCredential {
  id: string;
  accessToken: string;
  accountId: string;
  accountLabel: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Resolve the most-recently-updated active bearer credential for a provider.
 * Throws a connect-me error when none exists — tool code surfaces that to the
 * boss so it asks the user to connect rather than inventing an answer.
 */
export async function getActiveBearerCredential(
  userId: string,
  provider: string,
): Promise<ActiveBearerCredential> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      accessToken: integrationCredentials.accessToken,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, userId),
        eq(integrationCredentials.provider, provider),
        eq(integrationCredentials.status, "active"),
      ),
    )
    .orderBy(desc(integrationCredentials.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `[${provider}.credentials] no active ${provider} credential — connect ${provider} in settings`,
    );
  }
  return {
    id: row.id,
    accessToken: row.accessToken,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    metadata: row.metadata,
  };
}
