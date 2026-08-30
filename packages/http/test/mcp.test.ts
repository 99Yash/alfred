import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyServerEnvFixtures } from "./support/server-env";

// This suite makes only anonymous requests, so it never dials either service.
// The complete fixtures let the auth boundary parse its environment first.
applyServerEnvFixtures({
  databaseUrl: "postgresql://localhost:5432/alfred_test",
  redisUrl: "redis://localhost:6379",
});

const [{ Elysia }, { errorHandler, mcpIntegrationRoutes }] = await Promise.all([
  import("elysia"),
  import("@alfred/http"),
]);

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

  test("keeps recovery operations behind authentication", async () => {
    const app = new Elysia().use(errorHandler).use(mcpIntegrationRoutes);
    const requests = [
      new Request("http://localhost/api/integrations/mcp/recovery"),
      new Request("http://localhost/api/integrations/mcp/recovery/inv_1/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirmed_succeeded" }),
      }),
      new Request("http://localhost/api/integrations/mcp/recovery/inv_1/successor", {
        method: "POST",
      }),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      assert.equal(response.status, 401);
    }
  });

  test("publishes the canonical closed recovery decision at the HTTP boundary", () => {
    const app = new Elysia().use(errorHandler).use(mcpIntegrationRoutes);
    const route = app.routes.find(
      (candidate) =>
        candidate.method === "POST" &&
        candidate.path === "/api/integrations/mcp/recovery/:invocationId/resolve",
    );

    assert.ok(route);
    assert.deepEqual(JSON.parse(JSON.stringify(route.hooks.body)), {
      additionalProperties: false,
      type: "object",
      required: ["decision"],
      properties: {
        decision: {
          default: "confirmed_succeeded",
          type: "string",
          enum: ["confirmed_succeeded", "confirmed_not_applied"],
        },
      },
    });
  });
});
