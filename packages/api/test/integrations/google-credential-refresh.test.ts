import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db, rowsFromExecute } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { getFreshAccessToken, upsertCredential } from "@alfred/integrations/google";
import { eq, sql } from "drizzle-orm";
import { dbBackedSkip } from "../support/db-backed";

const SKIP = dbBackedSkip("database");

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

/** Seed a Google credential through the owner so the row holds sealed tokens. */
async function seedGoogleCredential(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes?: string[];
}): Promise<{ id: string }> {
  await db()
    .insert(user)
    .values({ id: args.userId, name: "Refresh Test", email: `${args.userId}@example.test` });
  return upsertCredential({
    userId: args.userId,
    provider: "google",
    accountId: randomUUID(),
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    expiresAt: args.expiresAt,
    scopes: args.scopes ?? ["scope:old"],
  });
}

/** Read the raw (still-sealed) token columns for a credential row. */
async function readStoredTokens(
  credentialId: string,
): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const [row] = await db()
    .select({
      accessToken: integrationCredentials.accessToken,
      refreshToken: integrationCredentials.refreshToken,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  return { accessToken: row?.accessToken ?? null, refreshToken: row?.refreshToken ?? null };
}

/**
 * Stub the provider token exchange for one refresh. `refreshToken` present ⇒ the
 * response carries a new refresh_token (rotation); omitted ⇒ Google's usual case
 * where the caller must carry the prior refresh token forward.
 */
function stubRefreshResponse(body: { access_token: string; refresh_token?: string }): {
  restore: () => void;
  requests: () => number;
} {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        expires_in: 3600,
        token_type: "Bearer",
        scope: "scope:new",
        ...body,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    requests: () => requests,
  };
}

describe("Google credential refresh (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  // Prove the pool actually reached the database `DATABASE_URL` names, so a green
  // DB-backed run cannot be one that silently skipped or hit the wrong database.
  // The campaign's isolated `alfred_c2` is confirmed at phase time by pointing
  // `DATABASE_URL` at it; a fixed literal would instead break CI (`alfred_ci`)
  // and every contributor running against `alfred` (NOTES 01-implement).
  test("the DB-backed suite connected to the database DATABASE_URL names", async () => {
    ensureOAuthTestEnv();
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL must be set for the DB-backed suite");
    const configured = new URL(databaseUrl).pathname.replace(/^\//, "");
    const rows = rowsFromExecute<{ current_database: string }>(
      await db().execute(sql`select current_database()`),
    );
    assert.equal(rows[0]?.current_database, configured);
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

  test("refresh reseals BOTH tokens when the provider returns a new refresh_token", async () => {
    ensureOAuthTestEnv();
    const userId = `test-google-reseal-rotate-${randomUUID()}`;
    const { id } = await seedGoogleCredential({
      userId,
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const stub = stubRefreshResponse({
      access_token: "fresh-access-token",
      refresh_token: "rotated-refresh-token",
    });
    try {
      const token = await getFreshAccessToken(id);
      assert.equal(token, "fresh-access-token");
      assert.equal(stub.requests(), 1);

      const stored = await readStoredTokens(id);
      // Access column: sealed envelope, never the plaintext the caller received.
      assert.notEqual(stored.accessToken, "fresh-access-token");
      assert.equal(credentialVault().open(stored.accessToken), "fresh-access-token");
      // Refresh column: the rotated token, resealed — dropping the seal on
      // credentials.ts:233 would leave "rotated-refresh-token" in plaintext here.
      assert.notEqual(stored.refreshToken, "rotated-refresh-token");
      assert.equal(credentialVault().open(stored.refreshToken), "rotated-refresh-token");
    } finally {
      stub.restore();
      await db().delete(user).where(eq(user.id, userId));
    }
  });

  test("refresh reseals the carried-forward refresh_token when the provider omits one", async () => {
    ensureOAuthTestEnv();
    const userId = `test-google-reseal-carry-${randomUUID()}`;
    const { id } = await seedGoogleCredential({
      userId,
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 60_000),
    });
    // Google's usual case: the refresh response omits refresh_token, so the code
    // carries the prior one forward — and must reseal it, not store it raw.
    const stub = stubRefreshResponse({ access_token: "fresh-access-token" });
    try {
      const token = await getFreshAccessToken(id);
      assert.equal(token, "fresh-access-token");
      assert.equal(stub.requests(), 1);

      const stored = await readStoredTokens(id);
      assert.notEqual(stored.accessToken, "fresh-access-token");
      assert.equal(credentialVault().open(stored.accessToken), "fresh-access-token");
      // The carried-forward prior refresh token, resealed. A dropped seal here
      // would persist the plaintext "refresh-token".
      assert.notEqual(stored.refreshToken, "refresh-token");
      assert.equal(credentialVault().open(stored.refreshToken), "refresh-token");
    } finally {
      stub.restore();
      await db().delete(user).where(eq(user.id, userId));
    }
  });

  test("a still-valid credential returns its token with no provider call and no row rewrite", async () => {
    ensureOAuthTestEnv();
    const userId = `test-google-still-valid-${randomUUID()}`;
    const { id } = await seedGoogleCredential({
      userId,
      accessToken: "seeded-access-token",
      refreshToken: "refresh-token",
      // Far in the future: outside the refresh threshold, so no refresh branch.
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const before = await readStoredTokens(id);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("provider must not be called for a still-valid credential");
    };
    try {
      const token = await getFreshAccessToken(id);
      assert.equal(token, "seeded-access-token");
      assert.equal(fetchCalls, 0);

      // No reseal churn: the sealed envelopes are byte-identical to what
      // upsertCredential wrote. A fall-through into the refresh branch would
      // rewrite these with fresh nonces (or call fetch).
      const after = await readStoredTokens(id);
      assert.equal(after.accessToken, before.accessToken);
      assert.equal(after.refreshToken, before.refreshToken);
    } finally {
      globalThis.fetch = originalFetch;
      await db().delete(user).where(eq(user.id, userId));
    }
  });
});
