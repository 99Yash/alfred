import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpRecoveryDecisionBodySchema, type McpRecoveryDecision } from "@alfred/contracts";
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
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(mcpIntegrationRoutes);

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
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(mcpIntegrationRoutes);
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

  test("publishes only the optional recovery cursor", async () => {
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(mcpIntegrationRoutes);
    const route = app.routes.find(
      (candidate) =>
        candidate.method === "GET" && candidate.path === "/api/integrations/mcp/recovery",
    );
    assert.ok(route);

    const validationProbe = new Elysia().get("/recovery", ({ query }) => query, {
      query: route.hooks.query,
    });
    const accepted = await validationProbe.handle(
      new Request("http://localhost/recovery?cursor=cursor-2"),
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { cursor: "cursor-2" });

    for (const query of ["cursor=", "extra=value"]) {
      const rejected = await validationProbe.handle(
        new Request(`http://localhost/recovery?${query}`),
      );
      assert.equal(rejected.status, 422);
    }
  });

  test("accepts exactly the two closed recovery decisions at the HTTP boundary", async () => {
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(mcpIntegrationRoutes);
    const route = app.routes.find(
      (candidate) =>
        candidate.method === "POST" &&
        candidate.path === "/api/integrations/mcp/recovery/:invocationId/resolve",
    );
    assert.ok(route);

    const decisions: unknown[] = [];
    const validationProbe = new Elysia({ normalize: "typebox" }).post(
      "/resolve",
      ({ body }) => {
        // `route.hooks.body` is untyped here; the contract schema is the reader.
        decisions.push(mcpRecoveryDecisionBodySchema.parse(body).decision);
        return null;
      },
      { body: route.hooks.body },
    );
    const acceptedDecisions: McpRecoveryDecision[] = [
      "confirmed_succeeded",
      "confirmed_not_applied",
    ];
    for (const decision of acceptedDecisions) {
      const response = await validationProbe.handle(
        new Request("http://localhost/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        }),
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual(decisions, acceptedDecisions);

    const extraKey = await validationProbe.handle(
      new Request("http://localhost/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirmed_succeeded", extra: true }),
      }),
    );
    assert.equal(extraKey.status, 422, "the body is a closed object");
  });

  test("rejects a missing or invalid recovery decision before the mutation runs", async () => {
    const routeApp = new Elysia({ normalize: "typebox" })
      .use(errorHandler)
      .use(mcpIntegrationRoutes);
    const route = routeApp.routes.find(
      (candidate) =>
        candidate.method === "POST" &&
        candidate.path === "/api/integrations/mcp/recovery/:invocationId/resolve",
    );
    assert.ok(route);

    let mutationCalls = 0;
    const validationProbe = new Elysia({ normalize: "typebox" }).post(
      "/resolve",
      () => {
        mutationCalls += 1;
        return null;
      },
      { body: route.hooks.body },
    );
    const rejectedBodies: unknown[] = [{}, { decision: "retry_automatically" }];

    for (const body of rejectedBodies) {
      const response = await validationProbe.handle(
        new Request("http://localhost/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      assert.equal(response.status, 422);
    }
    assert.equal(mutationCalls, 0);

    type InvalidDecisionStaysOutsideContract = "retry_automatically" extends McpRecoveryDecision
      ? false
      : true;
    const invalidDecisionStaysOutsideContract: InvalidDecisionStaysOutsideContract = true;
    assert.equal(invalidDecisionStaysOutsideContract, true);
  });
});
