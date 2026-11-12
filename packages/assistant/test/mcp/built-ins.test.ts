import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { serverEnv } from "@alfred/env/server";

import { GITHUB_MCP_ENDPOINT_HREF } from "../../src/connections/mcp/constants";
import { resolveBuiltInClient, type BuiltInOAuthConfig } from "../../src/connections/mcp/built-ins";

/**
 * The built-in registry is the only OAuth client source for providers that refuse dynamic registration.
 * The client id and secret come from `serverEnv()`, so the suite seeds its fixtures before the first read.
 */

const SERVER_ENV_FIXTURES = {
  DATABASE_URL: "postgres://localhost:5432/alfred_test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // `serverEnv()` requires a 32-byte credential KEK in every environment.
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "test-cf-token",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_GATEWAY_ID: "test-cf-gateway",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
} satisfies Record<string, string>;

function seedServerEnv(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

const ENDPOINT = new URL(GITHUB_MCP_ENDPOINT_HREF);

/** The callback every case registers. GitHub pins no `clientRegistrationRedirects`, so it is never judged here. */
const CALLBACK = new URL("http://localhost:3001/api/integrations/mcp/callback");

/** The `static` arm's client, for the cases that only assert one of its fields. */
function staticClient(endpoint: URL, issuerHint?: string): BuiltInOAuthConfig | undefined {
  const resolution = resolveBuiltInClient({ endpoint, redirectUrl: CALLBACK, issuerHint });

  return resolution.kind === "static" ? resolution.client : undefined;
}

describe("built-in MCP provider registry (#934)", () => {
  before(seedServerEnv);

  test("a client id and a secret resolve a confidential client", () => {
    const env = serverEnv();
    assert.deepEqual(resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }), {
      kind: "static",
      client: {
        issuer: "https://github.com/",
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      },
    });
  });

  test("a trailing slash still names the same built-in", () => {
    assert.ok(staticClient(new URL(`${GITHUB_MCP_ENDPOINT_HREF}/`)));
  });

  test("a redundant percent escape still names the same built-in", () => {
    assert.ok(staticClient(new URL("https://api.githubcopilot.com/%6Dcp/readonly")));
  });

  // `dynamic`, not `unavailable`: no built-in claims these endpoints, so the SDK registers its own client.
  test("a query or a fragment cannot inherit the pre-registered client", () => {
    assert.equal(
      resolveBuiltInClient({
        endpoint: new URL(`${GITHUB_MCP_ENDPOINT_HREF}?foo=1`),
        redirectUrl: CALLBACK,
      }).kind,
      "dynamic",
    );
    assert.equal(
      resolveBuiltInClient({
        endpoint: new URL(`${GITHUB_MCP_ENDPOINT_HREF}#frag`),
        redirectUrl: CALLBACK,
      }).kind,
      "dynamic",
    );
  });

  test("an unrelated endpoint gets no client", () => {
    assert.equal(
      resolveBuiltInClient({
        endpoint: new URL("https://evil.example.test/mcp"),
        redirectUrl: CALLBACK,
      }).kind,
      "dynamic",
    );
    assert.equal(
      resolveBuiltInClient({
        endpoint: new URL("https://api.githubcopilot.com/other"),
        redirectUrl: CALLBACK,
      }).kind,
      "dynamic",
    );
  });

  test("a discovered issuer under the pinned origin binds the client to that href", () => {
    assert.equal(
      staticClient(ENDPOINT, "https://github.com/login/oauth")?.issuer,
      "https://github.com/login/oauth",
    );
  });

  // A refused issuer must not read as "register dynamically", or the pin sends the caller to the refused origin.
  test("a discovered issuer on another origin refuses the client", () => {
    assert.deepEqual(
      resolveBuiltInClient({
        endpoint: ENDPOINT,
        redirectUrl: CALLBACK,
        issuerHint: "https://evil.example.test/",
      }),
      { kind: "unavailable", reason: "issuer_not_bound" },
    );
    assert.equal(
      resolveBuiltInClient({
        endpoint: ENDPOINT,
        redirectUrl: CALLBACK,
        issuerHint: "not-a-url",
      }).kind,
      "unavailable",
    );
  });
});
