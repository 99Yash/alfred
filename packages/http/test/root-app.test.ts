import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { auth } from "@alfred/auth";
import { db } from "@alfred/db";
import IORedis from "ioredis";

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

const EXPECTED_ROUTES = [
  "POST /api/replicache/pull",
  "POST /api/replicache/push",
  "GET /api/replicache/events",
  "GET /api/events/",
  "POST /api/events/_demo",
  "GET /api/agent/workflows",
  "POST /api/agent/runs",
  "POST /api/agent/runs/:runId/replay",
  "GET /api/agent/runs/:runId",
  "POST /api/agent/runs/:runId/signal",
  "POST /api/approvals/:stagingId/decision",
  "POST /api/chat/transcribe",
  "POST /api/chat/attachments/upload",
  "GET /api/chat/attachments/:id/content",
  "POST /api/chat/runs/:runId/stop",
  "POST /api/chat/threads/:threadId/turn",
  "GET /api/integrations/google/connect",
  "GET /api/integrations/google/credentials",
  "DELETE /api/integrations/google/:id",
  "PATCH /api/integrations/google/:id/persona",
  "POST /api/integrations/google/:id/watch",
  "DELETE /api/integrations/google/:id/watch",
  "GET /api/integrations/google/:id/watch",
  "POST /api/integrations/google/:id/ingest",
  "GET /api/integrations/google/callback",
  "GET /api/integrations/github/connect",
  "GET /api/integrations/github/credentials",
  "DELETE /api/integrations/github/:id",
  "GET /api/integrations/github/callback",
  "GET /api/integrations/notion/connect",
  "GET /api/integrations/notion/credentials",
  "DELETE /api/integrations/notion/:id",
  "GET /api/integrations/notion/callback",
  "POST /api/integrations/railway/connect",
  "GET /api/integrations/railway/credentials",
  "DELETE /api/integrations/railway/:id",
  "GET /api/integrations/vercel/connect",
  "GET /api/integrations/vercel/credentials",
  "DELETE /api/integrations/vercel/:id",
  "GET /api/integrations/vercel/callback",
  "POST /webhooks/gmail",
  "POST /webhooks/github",
  "GET /api/integrations/mcp/connections",
  "GET /api/integrations/mcp/github/connect",
  "GET /api/integrations/mcp/connections/:id/reconsent",
  "GET /api/integrations/mcp/client-metadata",
  "GET /api/integrations/mcp/callback",
  "GET /api/integrations/tool-tiers",
  "GET /api/me/inbox",
  "GET /api/me/inbox/:documentId",
  "POST /api/me/inbox/mark-read",
  "GET /api/me/meetings",
  "GET /api/me/briefings/latest",
  "POST /api/me/briefings/run",
  "GET /api/me/usage/summary",
  "GET /api/me/usage/breakdown",
  "GET /api/me/usage/activity",
  "GET /api/me/onboarding/",
  "POST /api/me/onboarding/complete",
  "POST /api/skills/",
  "POST /api/skills/:id/relearn",
  "POST /api/workflows/:id/recovery",
  "GET /health",
  "GET /ready",
  "GET /api/auth/get-session",
  "ALL /*",
] as const;

const expectedRoutes =
  process.env.NODE_ENV === undefined || process.env.NODE_ENV === "development"
    ? EXPECTED_ROUTES
    : EXPECTED_ROUTES.filter((route) => route !== "POST /api/events/_demo");

describe("@alfred/http root app", () => {
  test("keeps the complete ordered route surface", () => {
    assert.deepEqual(
      app.routes.map(({ method, path }) => `${method} ${path}`),
      expectedRoutes,
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

  test("keeps session caching, sign-out invalidation, and auth delegation", async (t) => {
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
