import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyServerEnvFixtures } from "./support/server-env";

applyServerEnvFixtures({
  databaseUrl: "postgresql://localhost:5432/alfred_test",
  redisUrl: "redis://localhost:6379",
});

const [{ auth }, { db }, { Elysia }, { errorHandler }, { authMacro }, { requireOnboarded }] =
  await Promise.all([
    import("@alfred/auth"),
    import("@alfred/db"),
    import("elysia"),
    import("../src/middleware/error-handler"),
    import("../src/middleware/auth"),
    import("../src/middleware/onboarding"),
  ]);

const app = new Elysia({ normalize: "typebox" })
  .use(errorHandler)
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (guarded) =>
    guarded.get("/guarded", () => ({ ok: true })),
  );

/**
 * Relative to now, not a fixed instant. The absolute session cap (#454) revokes
 * any session older than 30 days on read, so a hard-coded `createdAt` turns this
 * suite into a time bomb that starts failing 30 days after it was written.
 */
const SIGNED_IN_AT = new Date(Date.now() - 60_000);

const userSession = {
  session: {
    id: "session-1",
    createdAt: SIGNED_IN_AT,
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    userId: "user-1",
    expiresAt: new Date(Date.now() + 60_000),
    token: "token-1",
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "user-1",
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    email: "test@example.com",
    emailVerified: true,
    name: "Test User",
    image: null,
  },
};

function mockUserLookup(t: any, rows: Array<{ onboardedAt: Date | null }>) {
  const database = db();
  return t.mock.method(database, "select", () => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

describe("requireOnboarded", () => {
  test("returns 401 when the session is missing", async (t) => {
    const getSession = t.mock.method(auth().api, "getSession", async () => null);
    const select = t.mock.method(db(), "select", () => {
      throw new Error("db should not be read without a session");
    });

    const response = await app.handle(new Request("http://localhost/guarded"));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
    assert.equal(getSession.mock.callCount(), 1);
    assert.equal(select.mock.callCount(), 0);
  });

  test("returns 403 when the user is not onboarded", async (t) => {
    const getSession = t.mock.method(auth().api, "getSession", async () => userSession);
    const select = mockUserLookup(t, [{ onboardedAt: null }]);

    const response = await app.handle(
      new Request("http://localhost/guarded", {
        headers: { cookie: "better-auth.session_token=token-onboarding-null" },
      }),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Onboarding required",
      code: "FORBIDDEN",
    });
    assert.equal(getSession.mock.callCount(), 1);
    assert.equal(select.mock.callCount(), 1);
  });

  test("passes through when the user is onboarded", async (t) => {
    const getSession = t.mock.method(auth().api, "getSession", async () => userSession);
    const select = mockUserLookup(t, [{ onboardedAt: new Date("2026-08-12T00:00:00Z") }]);

    const response = await app.handle(
      new Request("http://localhost/guarded", {
        headers: { cookie: "better-auth.session_token=token-onboarding-set" },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(getSession.mock.callCount(), 1);
    assert.equal(select.mock.callCount(), 1);
  });
});
