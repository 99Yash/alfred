import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGoogleClient } from "../src/google/client";

describe("Google configured client", () => {
  test("resolves the selected credential afresh for every request", async () => {
    const originalFetch = globalThis.fetch;
    const authorization: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const resolvedCredentialIds: string[] = [];
    const client = createGoogleClient(async (credentialId) => {
      resolvedCredentialIds.push(credentialId);
      return `token-${resolvedCredentialIds.length}`;
    });
    try {
      await client.gmail.listMessages({ credentialId: "personal" });
      await client.gmail.listMessages({ credentialId: "work" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(resolvedCredentialIds, ["personal", "work"]);
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-2"]);
  });
});
