import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyServerEnvFixtures } from "./support/server-env";

/**
 * Coverage for the absolute session cap and the "sign out everywhere" cache
 * drop (#454).
 *
 * Better Auth slides `expires_at` forward on every use and has no option that
 * bounds the total, so the cap is Alfred's own code on the read path. Two
 * properties matter and neither is visible from the config:
 *
 *   1. a session past the cap is refused AND its row is deleted, because
 *      Better Auth's own mounted routes read that row and nothing else, and
 *   2. a revocation of some OTHER device's session drops the whole per-token
 *      cache, because that token is not in the request that revoked it.
 *
 * `auth().api.getSession` and `db()` are both mocked: the cap is arithmetic over
 * `created_at`, so a real Postgres would add a service dependency and no
 * evidence.
 */

applyServerEnvFixtures({
  databaseUrl: "postgresql://localhost:5432/alfred_test",
  redisUrl: "redis://localhost:6379",
});

const [
  { auth },
  { db },
  { app, clearSessionTokenCache, getSessionCached },
  { SESSION_LIFETIME_SECONDS },
] = await Promise.all([
  import("@alfred/auth"),
  import("@alfred/db"),
  import("@alfred/http"),
  import("@alfred/auth/session-policy"),
]);

const CAP_MS = SESSION_LIFETIME_SECONDS.absoluteMax * 1000;

function sessionSignedInAt(createdAt: Date, token: string) {
  return {
    session: {
      id: "session-1",
      createdAt,
      // The slide moves `updatedAt` and `expiresAt` and never `createdAt`, which
      // is exactly why the cap can be measured from `createdAt` at all. This
      // fixture states that: a session at the cap still looks perfectly current.
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      userId: "user-1",
      token,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: "user-1",
      createdAt,
      updatedAt: new Date(),
      email: "test@example.com",
      emailVerified: true,
      name: "Test User",
      image: null,
    },
  };
}

/** Records the tokens `revokeSessionByToken` deletes, without a database. */
function mockSessionDelete(t: { mock: { method: typeof import("node:test").mock.method } }) {
  const deleted: unknown[] = [];
  t.mock.method(db(), "delete", () => ({
    where: async (clause: unknown) => {
      deleted.push(clause);
    },
  }));
  return deleted;
}

describe("absolute session cap (#454)", () => {
  test("a session at the cap is refused and its row is deleted", async (t) => {
    clearSessionTokenCache();
    const request = new Request("http://localhost/x", {
      headers: { cookie: "better-auth.session_token=token-capped" },
    });
    t.mock.method(auth().api, "getSession", async () =>
      sessionSignedInAt(new Date(Date.now() - CAP_MS), "token-capped"),
    );
    const deleted = mockSessionDelete(t);

    assert.equal(await getSessionCached(request), null, "a capped session must not resolve");
    assert.equal(deleted.length, 1, "the row must be deleted, not just refused for one read");
  });

  test("a session one hour short of the cap still resolves and is not touched", async (t) => {
    clearSessionTokenCache();
    const request = new Request("http://localhost/x", {
      headers: { cookie: "better-auth.session_token=token-live" },
    });
    t.mock.method(auth().api, "getSession", async () =>
      sessionSignedInAt(new Date(Date.now() - CAP_MS + 60 * 60 * 1000), "token-live"),
    );
    const deleted = mockSessionDelete(t);

    const resolved = await getSessionCached(request);
    assert.equal(resolved?.session.token, "token-live");
    assert.equal(deleted.length, 0, "a live session must never be revoked");
  });

  test("a failed delete still refuses the session", async (t) => {
    clearSessionTokenCache();
    const request = new Request("http://localhost/x", {
      headers: { cookie: "better-auth.session_token=token-undeletable" },
    });
    t.mock.method(auth().api, "getSession", async () =>
      sessionSignedInAt(new Date(Date.now() - CAP_MS), "token-undeletable"),
    );
    t.mock.method(db(), "delete", () => ({
      where: async () => {
        throw new Error("database unavailable");
      },
    }));
    const warn = t.mock.method(console, "warn", () => {});

    // Honouring the cookie because the cleanup failed would invert the cap.
    assert.equal(await getSessionCached(request), null);
    assert.equal(warn.mock.callCount(), 1, "a failed revoke must say so");
  });
});

describe('"sign out everywhere" cache drop (#454)', () => {
  test("a successful revoke-other-sessions drops every cached token", async (t) => {
    clearSessionTokenCache();
    const victim = new Request("http://localhost/api/auth/get-session", {
      headers: { cookie: "better-auth.session_token=token-other-device" },
    });
    const getSession = t.mock.method(auth().api, "getSession", async () =>
      sessionSignedInAt(new Date(), "token-other-device"),
    );

    await getSessionCached(victim);
    assert.equal(getSession.mock.callCount(), 1);

    // A second read of the same token comes from the cache, which is the whole
    // reason the revocation below has to reach into it.
    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(getSession.mock.callCount(), 1, "the token must be cached before the revoke");

    t.mock.method(auth(), "handler", async () => new Response(null, { status: 200 }));
    const revoked = await app.handle(
      new Request("http://localhost/api/auth/revoke-other-sessions", {
        method: "POST",
        // Note the DIFFERENT token: the caller keeps its own session, so nothing
        // in this request names the token being revoked.
        headers: { cookie: "better-auth.session_token=token-this-device" },
      }),
    );
    assert.equal(revoked.status, 200);

    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(
      getSession.mock.callCount(),
      2,
      "the revoked token must be read from the database",
    );
  });

  test("a refused revoke leaves the cache alone", async (t) => {
    clearSessionTokenCache();
    const getSession = t.mock.method(auth().api, "getSession", async () =>
      sessionSignedInAt(new Date(), "token-other-device"),
    );
    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(getSession.mock.callCount(), 1);

    t.mock.method(auth(), "handler", async () => new Response(null, { status: 401 }));
    const refused = await app.handle(
      new Request("http://localhost/api/auth/revoke-other-sessions", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=token-this-device" },
      }),
    );
    assert.equal(refused.status, 401);

    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(getSession.mock.callCount(), 1, "a refused revoke must not clear the cache");
  });
});
