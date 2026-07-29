import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createNotionClient } from "../src/notion/client";

describe("Notion configured client", () => {
  test("resolves a fresh token for every request and keeps it out of call sites", async () => {
    const originalFetch = globalThis.fetch;
    const authorization: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify({ results: [], has_more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    let resolutions = 0;
    const client = createNotionClient(async () => `token-${++resolutions}`);
    try {
      await client.search({ filter: "all", pageSize: 10 });
      await client.search({ filter: "page", pageSize: 10 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(resolutions, 2);
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-2"]);
  });
});
