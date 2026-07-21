import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { getFreshAccessToken } from "@alfred/integrations/google";
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
    const [credential] = await db()
      .insert(integrationCredentials)
      .values({
        userId,
        provider: "google",
        accountId: randomUUID(),
        accessToken: "expired-access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() - 60_000),
        scopes: ["scope:old"],
      })
      .returning({ id: integrationCredentials.id });
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
      assert.equal(stored?.accessToken, "fresh-access-token");
    } finally {
      globalThis.fetch = originalFetch;
      await db().delete(user).where(eq(user.id, userId));
    }
  });
});
