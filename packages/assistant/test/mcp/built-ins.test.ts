import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { GITHUB_MCP_ENDPOINT_HREF } from "../../src/connections/mcp/constants";
import { resolveBuiltInClient } from "../../src/connections/mcp/built-ins";

/**
 * The built-in registry is the ONLY place Alfred can get an OAuth client for a
 * provider whose authorization server refuses dynamic registration (#934).
 * These tests are pure: they drive `process.env` directly, because the lazy
 * per-call read is the property that makes rotation work and makes a test
 * override possible.
 */

const CLIENT_ID = "GITHUB_MCP_CLIENT_ID";
const CLIENT_SECRET = "GITHUB_MCP_CLIENT_SECRET";
const ENDPOINT = new URL(GITHUB_MCP_ENDPOINT_HREF);

function setEnv(clientId?: string, clientSecret?: string): void {
  if (clientId === undefined) delete process.env[CLIENT_ID];
  else process.env[CLIENT_ID] = clientId;
  if (clientSecret === undefined) delete process.env[CLIENT_SECRET];
  else process.env[CLIENT_SECRET] = clientSecret;
}

describe("built-in MCP provider registry (#934)", () => {
  afterEach(() => setEnv(undefined, undefined));

  test("an unset client id leaves the built-in absent", () => {
    setEnv(undefined, undefined);
    assert.equal(resolveBuiltInClient(ENDPOINT), undefined);
  });

  test("a secret without a client id fails closed", () => {
    setEnv(undefined, "orphan-secret");
    assert.equal(resolveBuiltInClient(ENDPOINT), undefined);
  });

  test("a blank environment line counts as unset", () => {
    setEnv("   ", undefined);
    assert.equal(resolveBuiltInClient(ENDPOINT), undefined);
  });

  test("a client id alone resolves a public client on the pinned issuer", () => {
    setEnv("public-client", undefined);
    assert.deepEqual(resolveBuiltInClient(ENDPOINT), {
      issuer: "https://github.com/",
      clientId: "public-client",
    });
  });

  test("a client id and a secret resolve a confidential client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.deepEqual(resolveBuiltInClient(ENDPOINT), {
      issuer: "https://github.com/",
      clientId: "confidential-client",
      clientSecret: "confidential-secret",
    });
  });

  test("a rotated secret takes effect on the next call", () => {
    setEnv("confidential-client", "secret-one");
    assert.equal(resolveBuiltInClient(ENDPOINT)?.clientSecret, "secret-one");
    setEnv("confidential-client", "secret-two");
    assert.equal(resolveBuiltInClient(ENDPOINT)?.clientSecret, "secret-two");
  });

  test("a trailing slash still names the same built-in", () => {
    setEnv("confidential-client", undefined);
    assert.ok(resolveBuiltInClient(new URL(`${GITHUB_MCP_ENDPOINT_HREF}/`)));
  });

  test("a query or a fragment cannot inherit the pre-registered client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.equal(resolveBuiltInClient(new URL(`${GITHUB_MCP_ENDPOINT_HREF}?foo=1`)), undefined);
    assert.equal(resolveBuiltInClient(new URL(`${GITHUB_MCP_ENDPOINT_HREF}#frag`)), undefined);
  });

  test("an unrelated endpoint gets no client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.equal(resolveBuiltInClient(new URL("https://evil.example.test/mcp")), undefined);
    assert.equal(resolveBuiltInClient(new URL("https://api.githubcopilot.com/other")), undefined);
  });

  test("a discovered issuer under the pinned origin binds the client to that href", () => {
    setEnv("confidential-client", undefined);
    assert.equal(
      resolveBuiltInClient(ENDPOINT, "https://github.com/login/oauth")?.issuer,
      "https://github.com/login/oauth",
    );
  });

  test("a discovered issuer on another origin refuses the client", () => {
    setEnv("confidential-client", "confidential-secret");
    assert.equal(resolveBuiltInClient(ENDPOINT, "https://evil.example.test/"), undefined);
    assert.equal(resolveBuiltInClient(ENDPOINT, "not-a-url"), undefined);
  });
});
