import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import IORedis from "ioredis";
import { ambientRouteSurfaceCase, routeSurfaceFor } from "./support/route-surface";

const SERVER_ENV_FIXTURES: Record<string, string> = {
  DATABASE_URL: "postgresql://localhost:5432/alfred_test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  CORS_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/integrations/google/callback",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
};

for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

const { app } = await import("@alfred/http");

describe("@alfred/http root app", () => {
  // `ambientRouteSurfaceCase()` is read here, after the fixture loop above has seeded
  // `NODE_ENV`, so it describes the same value the barrel read at import time.
  // `../route-surface-env.test.ts` covers every other value in a child process each.
  test("keeps the complete ordered route surface", () => {
    assert.deepEqual(
      app.routes.map(({ method, path }) => `${method} ${path}`),
      routeSurfaceFor(ambientRouteSurfaceCase()),
    );
  });

  test("keeps health and readiness checks independent", async (t) => {
    const database = db();
    const execute = t.mock.method(database, "execute", async () => ({ rows: [{ ok: 1 }] }));
    const ping = t.mock.method(IORedis.prototype, "ping", async () => "PONG");
    t.mock.method(IORedis.prototype, "quit", async () => "OK");

    const health = await app.handle(new Request("http://localhost/health"));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, db: "connected" });

    const ready = await app.handle(new Request("http://localhost/ready"));
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, checks: { db: "ok", redis: "ok" } });

    execute.mock.mockImplementation(async () => {
      throw new Error("database unavailable");
    });
    const dbFailure = await app.handle(new Request("http://localhost/ready"));
    assert.equal(dbFailure.status, 503);
    assert.deepEqual(await dbFailure.json(), {
      ok: false,
      checks: { db: "error", redis: "ok" },
    });

    execute.mock.mockImplementation(async () => ({ rows: [{ ok: 1 }] }));
    ping.mock.mockImplementation(async () => {
      throw new Error("redis unavailable");
    });
    const redisFailure = await app.handle(new Request("http://localhost/ready"));
    assert.equal(redisFailure.status, 503);
    assert.deepEqual(await redisFailure.json(), {
      ok: false,
      checks: { db: "ok", redis: "error" },
    });
  });

  test("keeps session caching, sign-out invalidation, and auth delegation failures", async (t) => {
    const authInstance = auth();
    const session = {
      session: {
        id: "session-1",
        createdAt: new Date("2026-08-12T00:00:00Z"),
        updatedAt: new Date("2026-08-12T00:00:00Z"),
        userId: "user-1",
        expiresAt: new Date("2026-08-13T00:00:00Z"),
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
    let currentSession: typeof session | null = session;
    const getSession = t.mock.method(authInstance.api, "getSession", async () => currentSession);
    const handler = t.mock.method(
      authInstance,
      "handler",
      async () => new Response("delegated", { status: 202 }),
    );
    const headers = { cookie: "better-auth.session_token=token-1" };

    const first = await app.handle(
      new Request("http://localhost/api/auth/get-session", { headers }),
    );
    assert.equal(first.headers.get("cache-control"), "private, no-store");
    assert.equal(getSession.mock.callCount(), 1);

    currentSession = null;
    await app.handle(new Request("http://localhost/api/auth/get-session", { headers }));
    assert.equal(getSession.mock.callCount(), 1, "the token session stays cached before sign-out");

    const signOut = await app.handle(
      new Request("http://localhost/api/auth/sign-out", { method: "POST", headers }),
    );
    assert.equal(signOut.status, 202);
    assert.equal(await signOut.text(), "delegated");
    assert.equal(handler.mock.callCount(), 1);

    handler.mock.mockImplementation(async () => {
      throw new Error("auth handler unavailable");
    });
    const logError = t.mock.method(console, "error", () => {});
    const authFailure = await app.handle(new Request("http://localhost/api/auth/failure"));
    assert.equal(authFailure.status, 500);
    assert.deepEqual(await authFailure.json(), {
      error: "Internal server error",
      code: "INTERNAL_SERVER_ERROR",
    });
    assert.equal(logError.mock.callCount(), 1);

    const afterSignOut = await app.handle(
      new Request("http://localhost/api/auth/get-session", { headers }),
    );
    assert.equal(afterSignOut.status, 200);
    assert.equal(await afterSignOut.text(), "");
    assert.equal(
      getSession.mock.callCount(),
      2,
      "sign-out evicts the cached token before delegation",
    );
  });
});
