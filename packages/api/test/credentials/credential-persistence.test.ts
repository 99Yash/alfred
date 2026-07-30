import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  credentialVault,
  encryptPersistedOAuthCredentials,
  assertPersistedCredentialsSealed,
  CredentialVaultError,
} from "@alfred/db/credential-vault";
import { account, integrationCredentials, user } from "@alfred/db/schemas";
import { getGithubAccessToken, upsertGithubCredential } from "@alfred/integrations/github";
import {
  getFreshAccessToken,
  listCredentials,
  upsertCredential,
} from "@alfred/integrations/google";
import { getActiveBearerCredential, upsertBearerCredential } from "@alfred/integrations/shared";
import { eq } from "drizzle-orm";

/**
 * The invariant of #453, asserted against a real database: after any allowed
 * write, the *column* holds an envelope while the *public function* still
 * returns the original token.
 *
 * Reading through the same module that wrote is not enough on its own — a
 * no-op vault would pass that. Every case below also reads the raw column with
 * its own query.
 */

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

function ensureCredentialTestEnv(): void {
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-characters";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  process.env.ALFRED_ALLOWED_EMAIL ??= "test@example.test";
  process.env.RESEND_API_KEY ??= "test";
  process.env.RESEND_FROM_EMAIL ??= "test@example.test";
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= "test";
  process.env.GOOGLE_OAUTH_CLIENT_ID ??= "test";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= "test";
  process.env.GOOGLE_OAUTH_REDIRECT_URI ??= "http://localhost:3001/google/callback";
  process.env.GITHUB_APP_ID ??= "test";
  process.env.GITHUB_APP_SLUG ??= "test";
  process.env.GITHUB_APP_CLIENT_ID ??= "test";
  process.env.GITHUB_APP_CLIENT_SECRET ??= "test";
  process.env.GITHUB_APP_PRIVATE_KEY ??= "test";
  process.env.GITHUB_WEBHOOK_SECRET ??= "test";
  process.env.GITHUB_APP_REDIRECT_URI ??= "http://localhost:3001/github/callback";
  // The vault has no derived default, so the suite must supply a real key.
  process.env.OAUTH_CREDENTIAL_KEK ??= Buffer.from(
    "0123456789abcdef0123456789abcdef",
    "utf8",
  ).toString("base64url");
}

async function seedUser(prefix: string): Promise<string> {
  const userId = `${prefix}-${randomUUID()}`;
  await db()
    .insert(user)
    .values({ id: userId, name: "Vault Test", email: `${userId}@example.test` });
  return userId;
}

/** Read the columns straight out of Postgres, bypassing every owner module. */
async function rawIntegrationTokens(credentialId: string) {
  const rows = await db()
    .select({
      accessToken: integrationCredentials.accessToken,
      refreshToken: integrationCredentials.refreshToken,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const row = rows[0];
  assert.ok(row, "expected the credential row to exist");
  return row;
}

// One teardown for the file: a second `closeConnections()` would run against an
// already-ended pool.
after(async () => {
  await closeConnections();
});

describe("credential persistence is sealed at rest (DB-backed)", { skip: SKIP }, () => {
  test("google: connect, read, and refresh all keep the column sealed", async () => {
    ensureCredentialTestEnv();
    const vault = credentialVault();
    const userId = await seedUser("test-vault-google");
    const accountId = randomUUID();

    const { id } = await upsertCredential({
      userId,
      provider: "google",
      accountId,
      accessToken: "ya29.first-access",
      refreshToken: "1//first-refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["scope:a"],
    });

    let raw = await rawIntegrationTokens(id);
    assert.ok(vault.isSealed(raw.accessToken), "access_token reached Postgres unsealed");
    assert.ok(vault.isSealed(raw.refreshToken), "refresh_token reached Postgres unsealed");
    assert.notEqual(raw.accessToken, "ya29.first-access");
    // The two secrets must not share an envelope or a nonce.
    assert.notEqual(raw.accessToken, raw.refreshToken);
    // The public function still hands back the token the caller supplied.
    assert.equal(await getFreshAccessToken(id), "ya29.first-access");

    // A re-connect replaces the row in place and must not regress to plaintext.
    await upsertCredential({
      userId,
      provider: "google",
      accountId,
      accessToken: "ya29.second-access",
      refreshToken: "1//second-refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["scope:b"],
    });
    raw = await rawIntegrationTokens(id);
    assert.ok(vault.isSealed(raw.accessToken));
    assert.equal(await getFreshAccessToken(id), "ya29.second-access");

    // Expire it and let the refresh path write the new token back.
    await db()
      .update(integrationCredentials)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(integrationCredentials.id, id));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "ya29.refreshed",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "scope:c",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      assert.equal(await getFreshAccessToken(id), "ya29.refreshed");
    } finally {
      globalThis.fetch = originalFetch;
    }
    raw = await rawIntegrationTokens(id);
    assert.ok(vault.isSealed(raw.accessToken), "the refresh write-back bypassed the vault");
    assert.notEqual(
      raw.accessToken,
      "ya29.refreshed",
      "the column must not equal the refreshed plaintext",
    );
    assert.equal(vault.open(raw.accessToken), "ya29.refreshed");
  });

  test("google: listCredentials reports connectedness without moving ciphertext", async () => {
    ensureCredentialTestEnv();
    const userId = await seedUser("test-vault-google-list");
    const { id } = await upsertCredential({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accountLabel: "listed@example.test",
      accessToken: "ya29.listed",
      refreshToken: "1//listed",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["scope:a"],
    });

    const listed = await listCredentials(userId, "google");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, id);
    assert.equal(listed[0]?.accountLabel, "listed@example.test");
    // The summary type carries no token field at all, which is the point: the
    // refresh-token presence test is answered in SQL.
    assert.ok(!("accessToken" in (listed[0] ?? {})));
    assert.ok(!("refreshToken" in (listed[0] ?? {})));
  });

  test("github: the identity token is sealed and read back", async () => {
    ensureCredentialTestEnv();
    const vault = credentialVault();
    const userId = await seedUser("test-vault-github");
    const { id } = await upsertGithubCredential({
      userId,
      accountId: randomUUID(),
      accountLabel: "99Yash",
      accessToken: "ghu_identity-token",
      refreshToken: "ghr_refresh-token",
      installationId: "12345",
      scopes: ["repo"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const raw = await rawIntegrationTokens(id);
    assert.ok(vault.isSealed(raw.accessToken));
    assert.ok(vault.isSealed(raw.refreshToken));
    assert.equal(await getGithubAccessToken(id), "ghu_identity-token");
  });

  test("shared bearer: a Railway-style token is sealed and read back", async () => {
    ensureCredentialTestEnv();
    const vault = credentialVault();
    const userId = await seedUser("test-vault-bearer");
    const { id } = await upsertBearerCredential({
      userId,
      provider: "railway",
      accountId: randomUUID(),
      accountLabel: "workspace",
      // A Railway workspace token cannot be scoped down, which is why this row
      // is the worst one to leak.
      accessToken: "railway-workspace-token",
    });

    const raw = await rawIntegrationTokens(id);
    assert.ok(vault.isSealed(raw.accessToken));
    assert.notEqual(raw.accessToken, "railway-workspace-token");

    const active = await getActiveBearerCredential(userId, "railway");
    assert.equal(active.id, id);
    assert.equal(active.accessToken, "railway-workspace-token");
  });
});

describe("credential backfill (DB-backed)", { skip: SKIP }, () => {
  test("converts all five columns, is idempotent, and reports honestly", async () => {
    ensureCredentialTestEnv();
    const vault = credentialVault();
    const userId = await seedUser("test-vault-backfill");

    // Seed plaintext the way the pre-#453 code did: straight into the columns,
    // bypassing every owner module.
    const [seededAccount] = await db()
      .insert(account)
      .values({
        accountId: randomUUID(),
        providerId: "google",
        userId,
        accessToken: "plain-account-access",
        refreshToken: "plain-account-refresh",
        idToken: "plain-account-id",
      })
      .returning({ id: account.id });
    assert.ok(seededAccount);
    const [seededIntegration] = await db()
      .insert(integrationCredentials)
      .values({
        userId,
        provider: "google",
        accountId: randomUUID(),
        accessToken: "plain-integration-access",
        refreshToken: "plain-integration-refresh",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [],
      })
      .returning({ id: integrationCredentials.id });
    assert.ok(seededIntegration);

    // A row with a NULL refresh token proves nullable columns are left alone
    // rather than sealed into the string "null".
    const [nullableIntegration] = await db()
      .insert(integrationCredentials)
      .values({
        userId,
        provider: "notion",
        accountId: randomUUID(),
        accessToken: "plain-notion-access",
        refreshToken: null,
        scopes: [],
      })
      .returning({ id: integrationCredentials.id });
    assert.ok(nullableIntegration);

    // Check-only must report the plaintext without writing anything.
    const reported = await encryptPersistedOAuthCredentials({ checkOnly: true });
    assert.ok(reported.plaintextRemaining >= 6, "the report undercounted the seeded plaintext");
    assert.equal(reported.accountsUpdated, 0, "check-only must not write");
    assert.equal(reported.integrationsUpdated, 0, "check-only must not write");
    const stillPlain = await db()
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(eq(account.id, seededAccount.id));
    assert.equal(stillPlain[0]?.accessToken, "plain-account-access");

    // The boot gate must refuse a half-converted table.
    await assert.rejects(assertPersistedCredentialsSealed, CredentialVaultError);

    const first = await encryptPersistedOAuthCredentials();
    assert.ok(first.accountsUpdated >= 1);
    assert.ok(first.integrationsUpdated >= 2);
    assert.equal(first.plaintextRemaining, 0);

    const accountRow = (
      await db()
        .select({
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
        })
        .from(account)
        .where(eq(account.id, seededAccount.id))
    )[0];
    assert.ok(accountRow);
    assert.equal(vault.open(accountRow.accessToken), "plain-account-access");
    assert.equal(vault.open(accountRow.refreshToken), "plain-account-refresh");
    assert.equal(vault.open(accountRow.idToken), "plain-account-id");

    const integrationRow = await rawIntegrationTokens(seededIntegration.id);
    assert.equal(vault.open(integrationRow.accessToken), "plain-integration-access");
    assert.equal(vault.open(integrationRow.refreshToken), "plain-integration-refresh");
    // The owner module now reads it, which is the end-to-end proof.
    assert.equal(await getFreshAccessToken(seededIntegration.id), "plain-integration-access");

    const nullableRow = await rawIntegrationTokens(nullableIntegration.id);
    assert.equal(vault.open(nullableRow.accessToken), "plain-notion-access");
    assert.equal(nullableRow.refreshToken, null, "a NULL column must stay NULL");

    // Second run: nothing left to do, and the already-sealed rows are skipped
    // rather than double-sealed.
    const second = await encryptPersistedOAuthCredentials();
    assert.equal(second.accountsUpdated, 0);
    assert.equal(second.integrationsUpdated, 0);
    assert.equal(second.plaintextRemaining, 0);
    const afterSecond = await rawIntegrationTokens(seededIntegration.id);
    assert.equal(
      afterSecond.accessToken,
      integrationRow.accessToken,
      "an idempotent second run must not rewrite the envelope",
    );

    // And the boot gate now passes.
    await assertPersistedCredentialsSealed();
  });
});
