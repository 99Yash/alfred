import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { GITHUB_MCP_ENDPOINT_HREF } from "../../src/connections/mcp/constants";
import { resolveBuiltInClient, type BuiltInOAuthConfig } from "../../src/connections/mcp/built-ins";

/**
 * The built-in registry is the only OAuth client source for providers that refuse dynamic registration.
 * Tests set `process.env` directly: the lazy per-call read is what makes rotation work.
 */

const CLIENT_ID = "GITHUB_MCP_CLIENT_ID";

const CLIENT_SECRET = "GITHUB_MCP_CLIENT_SECRET";

const ENDPOINT = new URL(GITHUB_MCP_ENDPOINT_HREF);

/** The callback every case registers. GitHub pins no `clientRegistrationRedirects`, so it is never judged here. */
const CALLBACK = new URL("http://localhost:3001/api/integrations/mcp/callback");

/** The `static` arm's client, for the cases that only assert one of its fields. */
function staticClient(endpoint: URL, issuerHint?: string): BuiltInOAuthConfig | undefined {
  const resolution = resolveBuiltInClient({ endpoint, redirectUrl: CALLBACK, issuerHint });

  return resolution.kind === "static" ? resolution.client : undefined;
}

function setEnv(clientId?: string, clientSecret?: string): void {
  if (clientId === undefined) delete process.env[CLIENT_ID];
  else process.env[CLIENT_ID] = clientId;

  if (clientSecret === undefined) delete process.env[CLIENT_SECRET];
  else process.env[CLIENT_SECRET] = clientSecret;
}

describe("built-in MCP provider registry (#934)", () => {
  afterEach(() => setEnv(undefined, undefined));

  test("an unset client id refuses, and names the line to set", () => {
    setEnv(undefined, undefined);
    assert.deepEqual(resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }), {
      kind: "unavailable",
      reason: "missing_client_id",
      envKey: CLIENT_ID,
    });
  });

  test("a secret without a client id fails closed", () => {
    setEnv(undefined, "orphan-secret");
    assert.equal(
      resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }).kind,
      "unavailable",
    );
  });

  test("a blank environment line counts as unset", () => {
    setEnv("   ", undefined);
    assert.equal(
      resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }).kind,
      "unavailable",
    );
  });

  test("a client id alone resolves a public client on the pinned issuer", () => {
    setEnv("public-client", undefined);
    assert.deepEqual(resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }), {
      kind: "static",
      client: { issuer: "https://github.com/", clientId: "public-client" },
    });
  });

  test("a client id and a secret resolve a confidential client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.deepEqual(resolveBuiltInClient({ endpoint: ENDPOINT, redirectUrl: CALLBACK }), {
      kind: "static",
      client: {
        issuer: "https://github.com/",
        clientId: "confidential-client",
        clientSecret: "confidential-secret",
      },
    });
  });

  test("a rotated secret takes effect on the next call", () => {
    setEnv("confidential-client", "secret-one");
    assert.equal(staticClient(ENDPOINT)?.clientSecret, "secret-one");
    setEnv("confidential-client", "secret-two");
    assert.equal(staticClient(ENDPOINT)?.clientSecret, "secret-two");
  });

  test("a trailing slash still names the same built-in", () => {
    setEnv("confidential-client", undefined);
    assert.ok(staticClient(new URL(`${GITHUB_MCP_ENDPOINT_HREF}/`)));
  });

  test("a redundant percent escape still names the same built-in", () => {
    setEnv("confidential-client", undefined);
    assert.ok(staticClient(new URL("https://api.githubcopilot.com/%6Dcp/readonly")));
  });

  // `dynamic`, not `unavailable`: no built-in claims these endpoints, so the SDK registers its own client.
  test("a query or a fragment cannot inherit the pre-registered client", () => {
    setEnv("confidential-client", "confidential-secret");
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
    setEnv("confidential-client", "confidential-secret");
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
    setEnv("confidential-client", undefined);
    assert.equal(
      staticClient(ENDPOINT, "https://github.com/login/oauth")?.issuer,
      "https://github.com/login/oauth",
    );
  });

  // A refused issuer must not read as "register dynamically", or the pin sends the caller to the refused origin.
  test("a discovered issuer on another origin refuses the client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.deepEqual(
      resolveBuiltInClient({
        endpoint: ENDPOINT,
        redirectUrl: CALLBACK,
        issuerHint: "https://evil.example.test/",
      }),
      {
        kind: "unavailable",
        reason: "issuer_not_bound",
        envKey: CLIENT_ID,
      },
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
