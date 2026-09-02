import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Elysia } from "elysia";

import { errorHandler, mcpIntegrationRoutes } from "@alfred/http";
import { McpRawClient, type McpAuthorizedOAuth } from "@alfred/assistant/connections/mcp";
import { permissiveMcpEndpointAuthorizerForTests } from "@alfred/assistant/connections/mcp/test-support";
import { completeMcpOAuthCallback } from "../src/mcp";

describe("mcpIntegrationRoutes", () => {
  test("keeps the OAuth callback public and maps an invalid callback through errorHandler", async () => {
    const app = new Elysia().use(errorHandler).use(mcpIntegrationRoutes);

    const response = await app.handle(
      new Request("http://localhost/api/integrations/mcp/callback"),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Missing or invalid OAuth state",
      code: "BAD_REQUEST",
    });
  });

  test("keeps one authorized OAuth capability through a valid callback and reconnect", async () => {
    const events: string[] = [];
    const fallback = permissiveMcpEndpointAuthorizerForTests();
    let providerAuthorization: McpAuthorizedOAuth | null = null;
    const readyClient = new McpRawClient({
      connectionId: "conn_test",
      endpoint: {
        endpointUrl: "https://mcp.example.test/mcp",
        endpointOrigin: "https://mcp.example.test",
      },
      endpointAuthorizer: fallback,
      protocolFactory: () => {
        throw new Error("the callback must not open a second protocol client");
      },
    });
    const connectionManager = {
      events,
      async getReadyClient() {
        this.events.push("ready");
        return readyClient;
      },
    };
    const provider = {
      matchesState: async (state: string) => {
        events.push(`state:${state}`);
        return true;
      },
      discoveryState: async () => {
        events.push("discovery");
        return { authorizationServerUrl: "https://auth.example.test/" };
      },
      finishAuthorization: async (params: URLSearchParams) => {
        events.push("finish");
        assert.equal(params.get("code"), "valid-code");
        assert.ok(providerAuthorization);
      },
    };

    await completeMcpOAuthCallback({
      connection: {
        id: "conn_test",
        userId: "user_test",
        endpointUrl: "https://mcp.example.test/mcp",
        endpointOrigin: "https://mcp.example.test",
      },
      state: "valid-state",
      params: new URLSearchParams({ code: "valid-code", state: "valid-state" }),
      dependencies: {
        endpointAuthorizer: {
          authorize: async (connection, network) => {
            events.push("authorize");
            const authorized = await fallback.authorize(connection, network);
            return {
              ...authorized,
              close: async () => {
                events.push("close");
                await authorized.close();
              },
            };
          },
        },
        providerForConnection: (input) => {
          events.push("provider");
          providerAuthorization = input.authorization;
          return provider;
        },
        connectionManager,
      },
    });

    assert.deepEqual(events, [
      "authorize",
      "provider",
      "state:valid-state",
      "discovery",
      "finish",
      "ready",
      "close",
    ]);
  });
});
