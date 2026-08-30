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

  assert.equal(authorized.endpoint.href, authorized.oauthResource.href);
  await authorized.fetch("https://auth.example.test/token", { method: "POST", body: "code=one" });
  await assert.rejects(
    authorized.protocolFetch("https://auth.example.test/token"),
    /stored origin/,
  );
  assert.deepEqual(seen, ["https://auth.example.test/token"]);
  await authorized.close();
});
