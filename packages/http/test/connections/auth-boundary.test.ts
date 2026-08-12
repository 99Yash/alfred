import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Elysia } from "elysia";

import { notionIntegrationRoutes } from "../../src/connections/notion-routes";
import { errorHandler } from "../../src/middleware/error-handler";

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

describe("connections auth boundary", () => {
  const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(notionIntegrationRoutes);

  test("keeps the OAuth callback outside the auth guard", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/integrations/notion/callback?error=cancelled"),
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "http://localhost:3000/integrations?notion_error=cancelled",
    );
  });

  test("keeps credential access inside the auth guard", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/integrations/notion/credentials"),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
  });
});
