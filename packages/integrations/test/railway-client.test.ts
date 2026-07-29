import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createRailwayClient } from "../src/railway/client";
import type { ActiveBearerCredential } from "../src/shared/credentials";

const CREDENTIAL: ActiveBearerCredential = {
  id: "credential_1",
  accessToken: "railway-secret",
  accountId: "account_1",
  accountLabel: "Primary",
  metadata: {},
};

describe("Railway configured client", () => {
  test("loads credentials once and returns opaque per-credential capabilities", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            deployments: { edges: [] },
            deploymentLogs: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    let loads = 0;
    const client = createRailwayClient(async () => {
      loads += 1;
      return [CREDENTIAL];
    }, "none");
    try {
      const credential = (await client.credentials())[0];
      assert.ok(credential);
      assert.equal("accessToken" in credential, false);
      await credential.listDeployments({ projectId: "project_1", limit: 10 });
      await credential.getLogs({ deploymentId: "deployment_1", limit: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(loads, 1, "fan-out methods must not re-query the credential store");
  });

  test("honors the bind retry envelope for GraphQL reads", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ data: { deploymentLogs: [] } }), {
        status: attempts === 1 ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = createRailwayClient(async () => [CREDENTIAL], {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    try {
      const credential = (await client.credentials())[0];
      assert.ok(credential);
      await credential.getLogs({ deploymentId: "deployment_1", limit: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(attempts, 2);
  });
});
