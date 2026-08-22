import { rowToCredentialWire, type BearerProvider, type CredentialRowWire, type IntegrationSlug } from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, type IntegrationCredential } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

/**
 * Shared persistence layer for providers whose access is a single long-lived
 * bearer token — Notion (OAuth, non-expiring access token), Vercel (OAuth,
 * non-expiring), and Railway (a pasted account/workspace API token). None of them need
 * Google's refresh-on-demand machinery, so the whole layer is "store one
 * bearer token, read it back." Google and GitHub keep their bespoke modules
 * (refresh rotation / installation-token minting); this is the third pattern.
 *
 * Known v1 limitation — staleness is discovered lazily: a token revoked on the
 * provider side stays `status: 'active'` here until the next tool call fails
 * authz (surfaced as a fan-out `failure` or a thrown connect-me error). Nothing
 * proactively flips a dead token to a needs-reauth state, so the settings UI
 * shows "Connected" for a revoked token until something tries to use it. Fine at
 * single-user scale; a background health-check that demotes failing credentials
 * is the obvious follow-up.
 *
 * One of the three owners of credential encryption at rest (#453). The bearer
 * tokens here are the ones a leaked row would hurt most — a Railway workspace
 * token cannot be scoped down — so they are sealed on write and opened only in
 * the two functions that exist to hand a caller a usable token.
 */

/**
 * The providers this module is FOR are named by `CREDENTIAL_SHAPE` in
 * `@alfred/contracts`, and {@link BearerProvider} is the `"bearer"` subset of
 * that map. Which providers they are was previously prose in the docstring above
 * while the signatures took a bare `string`, so
 * `getActiveBearerCredential(userId, "gmail")` — a provider whose tokens this
 * store cannot serve — compiled fine and failed at runtime as a "connect gmail"
 * error for an already-connected account. It was then a hand-written tuple here,
 * which fixed that but left the same taxonomy spelled again in the web
 * connectedness probe. Deriving both from the one exhaustive map means a new
 * integration cannot be added without declaring how its credential works.
 */
export type { BearerProvider };

export interface UpsertBearerCredentialArgs {
  userId: string;
  /** `integration_credentials.provider`, narrowed to the bearer-token providers. */
  provider: BearerProvider;
  /** Provider-side stable id (workspace id, team/user id, account id). */
  accountId: string;
  accountLabel?: string | null | undefined;
  accessToken: string;
  /** Most bearer providers issue none; kept for parity with the column. */
  refreshToken?: string | null | undefined;
  /** Null for non-expiring tokens (the common case here). */
  expiresAt?: Date | null | undefined;
  scopes?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Insert or replace the credential row for `(user, provider, account)`. The
 * unique index makes a re-connect of the same account a clean in-place update
 * rather than a duplicate, exactly like the Google/GitHub upserts.
 */
export async function upsertBearerCredential(
  args: UpsertBearerCredentialArgs,
): Promise<{ id: string }> {
  const vault = credentialVault();
  // Sealed once and reused by both the insert and the on-conflict update.
  const sealedAccessToken = vault.seal(args.accessToken);
  const sealedRefreshToken = args.refreshToken ? vault.seal(args.refreshToken) : null;
  const result = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: args.provider,
      accountId: args.accountId,
      accountLabel: args.accountLabel ?? null,
      accessToken: sealedAccessToken,
      refreshToken: sealedRefreshToken,
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
        accessToken: sealedAccessToken,
        refreshToken: sealedRefreshToken,
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

/**
 * Delete one credential row, scoped to its owner and provider. Returns the
 * deleted id, or `null` when nothing matched (wrong owner, already gone, or a
 * provider mismatch) so callers can turn that into a 404. Generic across every
 * provider — Google/GitHub rows live in the same table, so a disconnect is the
 * same scoped row delete regardless of how the token was originally minted. That
 * is why this one takes {@link IntegrationSlug} and not {@link BearerProvider}:
 * the breadth is deliberate, and now it says so in the type rather than only in
 * this sentence.
 */
export async function deleteIntegrationCredential(args: {
  userId: string;
  provider: IntegrationSlug;
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

/** List a user's credential rows for a bearer-token provider (UI status + management). */
export async function listBearerCredentials(
  userId: string,
  provider: BearerProvider,
): Promise<CredentialRowWire[]> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      accountId: integrationCredentials.accountId,
      accountLabel: integrationCredentials.accountLabel,
      status: integrationCredentials.status,
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
  return rows.map(rowToCredentialWire);
}

export type ActiveBearerCredential = Pick<
  IntegrationCredential,
  "id" | "accountId" | "accountLabel" | "metadata"
> & {
  /**
   * The **opened** bearer token, usable against the provider. Deliberately not
   * derived from the column: `integration_credentials.access_token` is a sealed
   * envelope, and one `string` type naming both representations is how a caller
   * ends up sending ciphertext to Notion.
   */
  accessToken: string;
};

/**
 * List active bearer credentials, newest-updated first (capped at `limit`).
 *
 * @internal Credential boundary for provider clients and non-tool background
 * callers that do not have a ToolExecuteContext.
 */
export async function listActiveBearerCredentials(
  userId: string,
  provider: BearerProvider,
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

/**
 * Resolve the most-recently-updated active bearer credential for a provider.
 * Throws a connect-me error when none exists — tool code surfaces that to the
 * boss so it asks the user to connect rather than inventing an answer.
 *
 * Provider clients use this internally. Tool code enters through
 * `ctx.integrations.<provider>` and never receives the returned token.
 *
 * @internal Credential boundary for provider clients and non-tool background
 * callers that do not have a ToolExecuteContext.
 */
export async function getActiveBearerCredential(
  userId: string,
  provider: BearerProvider,
  accountRef?: string,
): Promise<ActiveBearerCredential> {
  const rows = await listActiveBearerCredentials(userId, provider, 1, accountRef);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `[${provider}.credentials] no active ${provider} credential — connect ${provider} in settings`,
    );
  }
  // `row` is already an ActiveBearerCredential (the list query selects exactly
  // these columns), so no re-map is needed.
  return row;
}
