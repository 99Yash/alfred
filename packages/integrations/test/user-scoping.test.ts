import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db, rowsFromExecute } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import {
  GoogleCredentialSelectionError,
  googleClientForUser,
  listCredentials,
  upsertCredential,
} from "../src/google/index";
import { listGithubCredentials, upsertGithubCredential } from "../src/github/index";
import {
  getActiveBearerCredential,
  listActiveBearerCredentials,
  upsertBearerCredential,
} from "../src/shared/index";
import { eq, sql } from "drizzle-orm";
import { dbBackedSkip } from "./support/db-backed";
import { GOOGLE_SCOPE } from "@alfred/contracts";

const SKIP = dbBackedSkip("database");

function ensureCredentialTestEnv(): void {
  process.env.REDIS_URL ??= "redis://localhost:6379"; // drift-ok: seeds a fixture value, does not gate a suite
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

async function seedUser(prefix: string): Promise<string> {
  const userId = `${prefix}-${randomUUID()}`;
  await db()
    .insert(user)
    .values({ id: userId, name: "Scoping Test", email: `${userId}@example.test` });
  return userId;
}

/**
 * Every credential-read path the `integrations({ userId })` root funnels through
 * must return only the bound user's rows. The scoping does NOT live in the leaf
 * token functions (`getFreshAccessToken`/`getGithubAccessToken` are id-only, no
 * userId predicate — a test aimed there is a false lock); it lives in the client
 * selection gates and the Google resolver's ownership revalidation. These tests
 * hit the gates.
 */
describe("credential reads are scoped to the bound user (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  test("the DB-backed suite connected to the database DATABASE_URL names", async () => {
    ensureCredentialTestEnv();
    const databaseUrl = process.env.DATABASE_URL; // drift-ok: asserts which database the suite reached; dbBackedSkip already gated it
    assert.ok(databaseUrl, "DATABASE_URL must be set for the DB-backed suite");
    const configured = new URL(databaseUrl).pathname.replace(/^\//, "");
    const rows = rowsFromExecute<{ current_database: string }>(
      await db().execute(sql`select current_database()`),
    );
    assert.equal(rows[0]?.current_database, configured);
  });

  // Bearer providers (notion/railway/vercel) converge on ONE WHERE clause in
  // shared/credentials.ts, so notion stands in for all three. Dropping the
  // `eq(userId)` predicate would leak B's row into A's reads here.
  test("bearer: reads bound to A never return B's credential", async () => {
    ensureCredentialTestEnv();
    const userA = await seedUser("test-scope-bearer-a");
    const userB = await seedUser("test-scope-bearer-b");
    try {
      const a = await upsertBearerCredential({
        userId: userA,
        provider: "notion",
        accountId: `a-${randomUUID()}`,
        accessToken: "notion-token-a",
      });
      const b = await upsertBearerCredential({
        userId: userB,
        provider: "notion",
        accountId: `b-${randomUUID()}`,
        accessToken: "notion-token-b",
      });

      const listed = await listActiveBearerCredentials(userA, "notion");
      assert.deepEqual(
        listed.map((r) => r.id),
        [a.id],
      );
      assert.ok(!listed.some((r) => r.id === b.id), "B's row must not appear in A's list");

      const active = await getActiveBearerCredential(userA, "notion");
      assert.equal(active.id, a.id);
      assert.equal(active.accessToken, "notion-token-a");
    } finally {
      await db().delete(user).where(eq(user.id, userA));
      await db().delete(user).where(eq(user.id, userB));
    }
  });

  // Google selection gate: listCredentials(userId, "google"). Every google client
  // method funnels through this gate, so it is the seam to lock.
  test("google: listCredentials(A) returns only A's rows", async () => {
    ensureCredentialTestEnv();
    const userA = await seedUser("test-scope-google-a");
    const userB = await seedUser("test-scope-google-b");
    try {
      const a = await upsertCredential({
        userId: userA,
        provider: "google",
        accountId: `a-${randomUUID()}`,
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scopes: [GOOGLE_SCOPE.gmail.readonly],
      });
      const b = await upsertCredential({
        userId: userB,
        provider: "google",
        accountId: `b-${randomUUID()}`,
        accessToken: "access-b",
        refreshToken: "refresh-b",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scopes: [GOOGLE_SCOPE.gmail.readonly],
      });

      const rows = await listCredentials(userA, "google");
      assert.deepEqual(
        rows.map((r) => r.id),
        [a.id],
      );
      assert.ok(!rows.some((r) => r.id === b.id), "B's row must not appear in A's list");
    } finally {
      await db().delete(user).where(eq(user.id, userA));
      await db().delete(user).where(eq(user.id, userB));
    }
  });

  // Google client foreign-id revalidation: a client bound to A must reject B's
  // credentialId at the resolver, BEFORE any provider call. Dropping the
  // ownership revalidation in google/client.ts would resolve B's token instead.
  test("google: a client bound to A rejects B's credentialId before any provider call", async () => {
    ensureCredentialTestEnv();
    const userA = await seedUser("test-scope-google-foreign-a");
    const userB = await seedUser("test-scope-google-foreign-b");

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("provider must not be called: the gate rejects a foreign id pre-fetch");
    };
    try {
      // A owns its own credential; B owns the one A will illegitimately name.
      await upsertCredential({
        userId: userA,
        provider: "google",
        accountId: `a-${randomUUID()}`,
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scopes: [GOOGLE_SCOPE.gmail.readonly],
      });
      const b = await upsertCredential({
        userId: userB,
        provider: "google",
        accountId: `b-${randomUUID()}`,
        accessToken: "access-b",
        refreshToken: "refresh-b",
        // Non-expiring + gmail scope: under the mutation, the resolver would
        // happily resolve this instead of throwing.
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scopes: [GOOGLE_SCOPE.gmail.readonly],
      });

      const clientForA = googleClientForUser({ userId: userA, retry: "none" });
      await assert.rejects(
        () => clientForA.gmail.listMessages({ credentialId: b.id, q: "in:inbox", maxResults: 1 }),
        (err: unknown) => err instanceof GoogleCredentialSelectionError,
      );
      assert.equal(fetchCalls, 0, "the gate must throw before any provider call");
    } finally {
      globalThis.fetch = originalFetch;
      await db().delete(user).where(eq(user.id, userA));
      await db().delete(user).where(eq(user.id, userB));
    }
  });

  // GitHub selection gate: listGithubCredentials(userId). Stop before installation
  // token minting, which needs network — the DB list is the scoping seam.
  test("github: listGithubCredentials(A) returns only A's rows", async () => {
    ensureCredentialTestEnv();
    const userA = await seedUser("test-scope-github-a");
    const userB = await seedUser("test-scope-github-b");
    try {
      const a = await upsertGithubCredential({
        userId: userA,
        accountId: `a-${randomUUID()}`,
        accessToken: "gh-token-a",
        scopes: ["repo"],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const b = await upsertGithubCredential({
        userId: userB,
        accountId: `b-${randomUUID()}`,
        accessToken: "gh-token-b",
        scopes: ["repo"],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });

      const rows = await listGithubCredentials(userA);
      assert.deepEqual(
        rows.map((r) => r.id),
        [a.id],
      );
      assert.ok(!rows.some((r) => r.id === b.id), "B's row must not appear in A's list");
    } finally {
      await db().delete(user).where(eq(user.id, userA));
      await db().delete(user).where(eq(user.id, userB));
    }
  });
});
