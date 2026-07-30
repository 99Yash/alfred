import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { getFreshAccessToken, upsertCredential } from "@alfred/integrations/google";
import { eq } from "drizzle-orm";

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

function ensureOAuthTestEnv(): void {
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
  // #453: the vault has no derived default, so the suite supplies a key.
  process.env.OAUTH_CREDENTIAL_KEK ??= Buffer.from(
    "0123456789abcdef0123456789abcdef",
    "utf8",
  ).toString("base64url");
}

describe("Google credential refresh (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  test("concurrent callers share one serialized token refresh", async () => {
    ensureOAuthTestEnv();
    const userId = `test-google-refresh-${randomUUID()}`;
    await db()
      .insert(user)
      .values({ id: userId, name: "Refresh Test", email: `${userId}@example.test` });
    // Seed through the owner, not with a raw insert: the row must hold sealed
    // tokens (#453) or the refresh path below would be exercising a state the
    // application can no longer produce.
    const credential = await upsertCredential({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 60_000),
      scopes: ["scope:old"],
    });
    assert.ok(credential);

    const originalFetch = globalThis.fetch;
    let refreshRequests = 0;
    globalThis.fetch = async () => {
      refreshRequests++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "scope:new",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const tokens = await Promise.all(
        Array.from({ length: 5 }, () => getFreshAccessToken(credential.id)),
      );
      assert.deepEqual(
        tokens,
        Array.from({ length: 5 }, () => "fresh-access-token"),
      );
      assert.equal(refreshRequests, 1);

      const [stored] = await db()
        .select({ accessToken: integrationCredentials.accessToken })
        .from(integrationCredentials)
        .where(eq(integrationCredentials.id, credential.id));
      // The column must NOT equal the plaintext the callers received — that
      // inequality is the whole point of the vault — and must open back to it.
      assert.notEqual(stored?.accessToken, "fresh-access-token");
      assert.equal(credentialVault().open(stored?.accessToken), "fresh-access-token");
    } finally {
      globalThis.fetch = originalFetch;
      await db().delete(user).where(eq(user.id, userId));
    }
  });
});
