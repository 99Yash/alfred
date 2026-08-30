import assert from "node:assert/strict";
import { test } from "node:test";
import { HostedMcpEndpointAuthorizer } from "../../src/connections/mcp/endpoint-authorization";

test("MCP authorization correlates the resource with public OAuth and origin-pinned protocol fetches", async () => {
  const seen: string[] = [];
  const authorizer = new HostedMcpEndpointAuthorizer({
    requester: async (input) => {
      seen.push(String(input));
      return new Response("ok");
    },
  });
  const authorized = await authorizer.authorize({
    endpoint: "https://mcp.example.test/mcp",
    expectedOrigin: "https://mcp.example.test",
  });

  assert.equal(authorized.protocol.endpoint.href, authorized.oauth.resource.href);
  const server = authorized.oauth.authorizeServer("https://auth.example.test/");
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
  assert.deepEqual(seen, ["https://auth.example.test/token"]);
  await authorized.close();
});
