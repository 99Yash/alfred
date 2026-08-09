import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createNotionClient } from "../src/notion/client";

describe("Notion configured client", () => {
  test("keeps additive provider fields isolated and degrades malformed title fragments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: "page_1",
              object: "page",
              url: "https://notion.so/page_1",
              last_edited_time: "2026-08-01T00:00:00.000Z",
              properties: {
                Broken: null,
                Name: {
                  type: "title",
                  title: [{ plain_text: "Roadmap", future_field: true }],
                },
              },
              future_top_level_field: { nested: true },
            },
            {
              id: "database_1",
              object: "database",
              title: [{ plain_text: null }],
            },
          ],
          has_more: false,
          future_envelope_field: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const result = await createNotionClient(async () => "token").search({
        filter: "all",
        pageSize: 10,
      });
      assert.deepEqual(
        result.hits.map(({ id, title }) => ({ id, title })),
        [
          { id: "page_1", title: "Roadmap" },
          { id: "database_1", title: "" },
        ],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  test("pins one credential identity across every request in a public operation", async () => {
    const originalFetch = globalThis.fetch;
    const authorization: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      authorization.push(auth);
      const body = String(input).includes("/pages/")
        ? {
            id: "page_1",
            properties: {
              Name: { type: "title", title: [{ plain_text: auth }] },
            },
          }
        : {
            results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: auth }] } }],
            has_more: false,
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    let resolutions = 0;
    const client = createNotionClient(async () => `token-${++resolutions}`);
    try {
      const page = await client.getPage({ pageId: "page_1" });
      assert.equal(page.title, "Bearer token-1");
      assert.equal(page.text, "Bearer token-1");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(resolutions, 1);
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-1"]);
  });

  test("honors the bind retry envelope for read-via-POST search", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ results: [], has_more: false }), {
        status: attempts === 1 ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = createNotionClient(async () => "token", {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    try {
      await client.search({ filter: "all", pageSize: 10 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(attempts, 2);
  });
});
