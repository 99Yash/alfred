import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyServerEnvFixtures } from "./support/server-env";

/** Coverage for native-expiry cache bounds and cross-token revocation (#454). */

applyServerEnvFixtures({
  databaseUrl: "postgresql://localhost:5432/alfred_test",
  redisUrl: "redis://localhost:6379",
});

const [
  { auth },
  { authSessionPolicy, SESSION_LIFETIME_SECONDS },
  { betterAuth },
  { APIError },
  { makeSignature },
  http,
  sessionCache,
] = await Promise.all([
  import("@alfred/auth"),
  import("@alfred/auth/session-policy"),
  import("better-auth"),
  import("better-auth/api"),
  import("better-auth/crypto"),
  import("@alfred/http"),
  import("../src/middleware/session-cache"),
]);
const { app, getSessionCached } = http;
const { clearSessionTokenCache } = sessionCache;

function sessionWithExpiry(token: string, expiresAt: Date) {
  const now = new Date();
  return {
    session: {
      id: "session-1",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      userId: "user-1",
      token,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: "user-1",
      createdAt: now,
      updatedAt: now,
      email: "test@example.com",
      emailVerified: true,
      name: "Test User",
      image: null,
    },
  };
}

describe("session cache (#454)", () => {
  test("keeps whole-cache invalidation off the public HTTP interface", () => {
    assert.equal("clearSessionTokenCache" in http, false);
  });

  test("every in-flight waiter rechecks native expiry after resolution", async (t) => {
    clearSessionTokenCache();
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    const expiresAt = new Date(now + 1_000);
    const token = "token-expiring-inflight";
    t.mock.timers.enable({ apis: ["Date"], now });

    let resolveLookup: ((session: ReturnType<typeof sessionWithExpiry>) => void) | undefined;
    const lookup = new Promise<ReturnType<typeof sessionWithExpiry>>((resolve) => {
      resolveLookup = resolve;
    });
    const getSession = t.mock.method(auth().api, "getSession", async () => lookup);

    const first = getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
    );
    t.mock.timers.setTime(expiresAt.getTime());
    const lateWaiter = getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
    );

    assert.ok(resolveLookup);
    resolveLookup(sessionWithExpiry(token, expiresAt));

    assert.equal(await first, null);
    assert.equal(await lateWaiter, null);
    assert.equal(getSession.mock.callCount(), 1, "both callers must share the pending lookup");
  });

  test("a positive cache entry never outlives the session's native expiry", async (t) => {
    clearSessionTokenCache();
    const token = "token-near-expiry";
    const getSession = t.mock.method(auth().api, "getSession", async () =>
      sessionWithExpiry(token, new Date(Date.now())),
    );

    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
    );
    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
    );

    assert.equal(getSession.mock.callCount(), 2, "an expired session must not remain cached");
  });

  test("a legacy row cached one millisecond before the absolute cap is denied at the cap", async (t) => {
    clearSessionTokenCache();
    const dayMs = 24 * 60 * 60 * 1000;
    const originMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const capMs = originMs + SESSION_LIFETIME_SECONDS.absoluteMax * 1000;
    const legacyExpiryMs = originMs + 36 * dayMs;
    t.mock.timers.enable({ apis: ["Date"], now: originMs });

    const owner = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      ...authSessionPolicy(),
    });
    const context = await owner.$context;
    const user = await context.internalAdapter.createUser({
      id: "legacy-cache-user",
      email: "legacy-cache@example.com",
      emailVerified: true,
      name: "Legacy Cache",
    });
    const session = await context.internalAdapter.createSession(user.id);
    await context.adapter.update({
      model: "session",
      where: [{ field: "token", value: session.token }],
      update: { expiresAt: new Date(legacyExpiryMs) },
    });
    const signedToken = `${session.token}.${await makeSignature(session.token, context.secret)}`;
    const request = () =>
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `${context.authCookies.sessionToken.name}=${signedToken}` },
      });
    const getSession = t.mock.method(
      auth().api,
      "getSession",
      (input: Parameters<typeof owner.api.getSession>[0]) => owner.api.getSession(input),
    );

    t.mock.timers.setTime(capMs - 1);
    const beforeCap = await getSessionCached(request());
    assert.ok(beforeCap, "the request immediately before the cap must still be valid");
    assert.equal(
      beforeCap.session.expiresAt.getTime(),
      capMs,
      "the auth owner must replace the legacy expiry before HTTP caches it",
    );
    assert.equal(getSession.mock.callCount(), 1);

    t.mock.timers.setTime(capMs);
    await assert.rejects(
      getSessionCached(request()),
      (error) => error instanceof APIError && error.statusCode === 401,
    );
    assert.equal(
      getSession.mock.callCount(),
      2,
      "HTTP must expire the native deadline and return to the auth owner",
    );
  });

  test("any successful auth POST drops every cached token without a route list", async (t) => {
    clearSessionTokenCache();
    const victim = new Request("http://localhost/api/auth/get-session", {
      headers: { cookie: "better-auth.session_token=token-other-device" },
    });
    const getSession = t.mock.method(auth().api, "getSession", async () =>
      sessionWithExpiry("token-other-device", new Date(Date.now() + 60_000)),
    );

    await getSessionCached(victim);
    assert.equal(getSession.mock.callCount(), 1);

    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(getSession.mock.callCount(), 1, "the token must be cached before the revoke");

    t.mock.method(auth(), "handler", async () => new Response(null, { status: 200 }));
    const mutated = await app.handle(
      new Request("http://localhost/api/auth/future-mutation", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=token-this-device" },
      }),
    );
    assert.equal(mutated.status, 200);

    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(
      getSession.mock.callCount(),
      2,
      "a new auth mutation must invalidate without joining a route list",
    );
  });

  test("GETs, refused auth POSTs, and auth-prefix near-matches leave the cache alone", async (t) => {
    clearSessionTokenCache();
    const getSession = t.mock.method(auth().api, "getSession", async () =>
      sessionWithExpiry("token-other-device", new Date(Date.now() + 60_000)),
    );
    await getSessionCached(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=token-other-device" },
      }),
    );
    assert.equal(getSession.mock.callCount(), 1);

    const handler = t.mock.method(
      auth(),
      "handler",
      async () => new Response(null, { status: 200 }),
    );

    const read = await app.handle(new Request("http://localhost/api/auth/future-read"));
    assert.equal(read.status, 200);

    const nearMatch = await app.handle(
      new Request("http://localhost/api/authz/future-mutation", { method: "POST" }),
    );
    assert.equal(nearMatch.status, 200);

    handler.mock.mockImplementation(async () => new Response(null, { status: 401 }));
    const refused = await app.handle(
      new Request("http://localhost/api/auth/future-mutation", {
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
    assert.equal(
      getSession.mock.callCount(),
      1,
      "only a successful POST below the auth boundary may clear the cache",
    );
  });

  test("a pre-clear lookup cannot repopulate or evict the post-clear in-flight entry", async (t) => {
    clearSessionTokenCache();
    const token = "token-invalidation-race";
    const oldSession = sessionWithExpiry(token, new Date(Date.now() + 60_000));
    const freshSession = sessionWithExpiry(token, new Date(Date.now() + 120_000));
    freshSession.session.id = "session-fresh";

    let resolveOld: ((session: ReturnType<typeof sessionWithExpiry>) => void) | undefined;
    let resolveFresh: ((session: ReturnType<typeof sessionWithExpiry>) => void) | undefined;
    const oldLookup = new Promise<ReturnType<typeof sessionWithExpiry>>((resolve) => {
      resolveOld = resolve;
    });
    const freshLookup = new Promise<ReturnType<typeof sessionWithExpiry>>((resolve) => {
      resolveFresh = resolve;
    });
    let lookupCount = 0;
    const getSession = t.mock.method(auth().api, "getSession", async () => {
      lookupCount += 1;
      if (lookupCount === 1) return oldLookup;
      return freshLookup;
    });

    const request = () =>
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie: `better-auth.session_token=${token}` },
      });

    const beforeClear = getSessionCached(request());
    t.mock.method(auth(), "handler", async () => new Response(null, { status: 204 }));
    const mutation = await app.handle(
      new Request("http://localhost/api/auth/future-mutation", { method: "POST" }),
    );
    assert.equal(mutation.status, 204);

    const afterClear = getSessionCached(request());
    assert.equal(getSession.mock.callCount(), 2);

    assert.ok(resolveOld);
    resolveOld(oldSession);
    assert.equal(await beforeClear, oldSession);

    const secondWaiter = getSessionCached(request());
    assert.equal(
      getSession.mock.callCount(),
      2,
      "the old lookup must not remove the new in-flight entry",
    );

    assert.ok(resolveFresh);
    resolveFresh(freshSession);
    assert.equal(await afterClear, freshSession);
    assert.equal(await secondWaiter, freshSession);

    assert.equal(await getSessionCached(request()), freshSession);
    assert.equal(
      getSession.mock.callCount(),
      2,
      "the old lookup must not replace the fresh cached session",
    );
  });
});
