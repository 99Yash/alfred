import assert from "node:assert/strict";
import { test } from "node:test";
import { HostedMcpEndpointAuthorizer } from "../../src/connections/mcp/endpoint-authorization";

const CONNECTION = {
  endpointUrl: "https://mcp.example.test/mcp",
  endpointOrigin: "https://mcp.example.test",
};
const NETWORK = { requestTimeoutMs: 5_000 };

test("MCP authorization correlates the resource with public OAuth and origin-pinned protocol fetches", async () => {
  const seen: string[] = [];
  const authorizer = new HostedMcpEndpointAuthorizer({
    requester: async (input) => {
      seen.push(String(input));
      return new Response("ok");
    },
  });
  const authorized = await authorizer.authorize(CONNECTION, NETWORK);

  assert.equal(authorized.protocol.endpoint.href, authorized.oauth.resource.href);
  const server = authorized.oauth.authorizeServer("https://auth.example.test/");
  await authorized.oauth.fetch("https://discovery.example.test/.well-known/oauth");
  await assert.rejects(
    authorized.oauth.fetch("https://discovery.example.test/.well-known/oauth", {
      headers: { "x-api-key": "secret" },
    }),
    /is not authorized/,
  );
  await authorized.oauth.fetch("https://auth.example.test/token", {
    method: "POST",
    body: "code=one",
  });
  await assert.rejects(
    authorized.oauth.fetch("https://steal.example.test/token", {
      method: "POST",
      body: "refresh_token=secret",
    }),
    /is not authorized/,
  );
  await assert.rejects(
    authorized.protocol.fetch("https://auth.example.test/token"),
    /stored origin/,
  );
  assert.throws(
    () => server.validateEndpoint("http://127.0.0.1/authorize"),
    /private or internal|public HTTP/,
  );
  assert.throws(
    () => server.validateEndpoint("https://steal.example.test/authorize"),
    /stored origin/,
  );
  assert.deepEqual(seen, [
    "https://discovery.example.test/.well-known/oauth",
    "https://auth.example.test/token",
  ]);
  await authorized.close();
});

test("the protocol fetch follows same-origin redirects and refuses to leave the stored origin", async () => {
  const seen: string[] = [];
  const authorizer = new HostedMcpEndpointAuthorizer({
    requester: async (input) => {
      seen.push(input);
      if (input.endsWith("/start")) {
        return new Response(null, { status: 307, headers: { location: "/mcp" } });
      }
      if (input.endsWith("/leave")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/mcp" },
        });
      }
      return new Response("ok");
    },
  });
  const authorized = await authorizer.authorize(CONNECTION, NETWORK);
  try {
    const response = await authorized.protocol.fetch("https://mcp.example.test/start");
    assert.equal(await response.text(), "ok");
    await assert.rejects(
      authorized.protocol.fetch("https://mcp.example.test/leave"),
      /stored origin/,
    );
    await assert.rejects(
      authorized.protocol.fetch("https://mcp.example.test/start", { method: "POST", body: "{}" }),
      /not replayed/,
    );
    assert.deepEqual(seen, [
      "https://mcp.example.test/start",
      "https://mcp.example.test/mcp",
      "https://mcp.example.test/leave",
      "https://mcp.example.test/start",
    ]);
  } finally {
    await authorized.close();
  }
});

test("OAuth requests carry the connection's request deadline; protocol requests leave time to the SDK", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const authorizer = new HostedMcpEndpointAuthorizer({
    requester: async (_input, init) => {
      signals.push(init.signal);
      return new Response("ok");
    },
  });
  const authorized = await authorizer.authorize(CONNECTION, NETWORK);
  try {
    await authorized.oauth.fetch("https://mcp.example.test/.well-known/oauth-protected-resource");
    const caller = new AbortController();
    await authorized.oauth.fetch(
      "https://mcp.example.test/.well-known/oauth-authorization-server",
      {
        signal: caller.signal,
      },
    );
    await authorized.protocol.fetch("https://mcp.example.test/mcp");

    assert.ok(signals[0] instanceof AbortSignal, "a bare OAuth request gets a deadline");
    assert.ok(signals[1] instanceof AbortSignal, "a caller signal is kept alongside the deadline");
    caller.abort();
    assert.equal(signals[1]?.aborted, true);
    assert.equal(signals[2], undefined, "the protocol fetch adds no signal of its own");
  } finally {
    await authorized.close();
  }
});

test("close is idempotent and returns after the protocol stream has been abandoned", async () => {
  const authorized = await new HostedMcpEndpointAuthorizer().authorize(CONNECTION, NETWORK);
  const first = authorized.close();
  const second = authorized.close();
  assert.equal(first, second);
  await first;
});
