import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { authedFetch, INTEGRATION_FETCH_TIMEOUT_MS } from "../src/shared/authed-fetch";

/**
 * `authedFetch` is the curated-tier transport core the four vendor clients
 * (Vercel, Notion, GitHub, Railway) collapsed onto — the mechanism they had each
 * copied inline. These pin the wire contract the vendors now depend on: headers
 * spread from the profile, `Content-Type` added only for a body, JSON encoding,
 * default GET, default-follow redirect, and the shared timeout signal. It stubs
 * the global `fetch` and captures the `RequestInit`, so it runs offline.
 */

const realFetch = globalThis.fetch;

/** Swap in a fetch stub that records the (input, init) it was called with. */
function stubFetch(response: Response = new Response(null, { status: 200 })): {
  calls: Array<{ input: string | URL | Request; init?: RequestInit }>;
} {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("authedFetch", () => {
  test("a bare read: GET, profile headers, no body, no Content-Type", async () => {
    const { calls } = stubFetch();
    await authedFetch(
      { headers: { Authorization: "Bearer tok", Accept: "application/json" } },
      { url: "https://api.example.com/things" },
    );

    assert.equal(calls.length, 1);
    const { input, init } = calls[0]!;
    assert.equal(input, "https://api.example.com/things");
    assert.equal(init?.method, "GET");
    assert.deepEqual(init?.headers, { Authorization: "Bearer tok", Accept: "application/json" });
    assert.equal(init?.body, undefined);
    // A read carries no Content-Type — it is added only when a body is sent.
    assert.equal("Content-Type" in (init!.headers as Record<string, string>), false);
  });

  test("a write: JSON-encodes the body and adds Content-Type without clobbering profile headers", async () => {
    const { calls } = stubFetch();
    await authedFetch(
      { headers: { Authorization: "Bearer tok", "Notion-Version": "2022-06-28" } },
      { url: "https://api.example.com/pages", method: "POST", body: { title: "hi", n: 1 } },
    );

    const { init } = calls[0]!;
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, JSON.stringify({ title: "hi", n: 1 }));
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer tok",
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    });
  });

  test("body presence, not method, drives Content-Type (a false-y body still counts)", async () => {
    const { calls } = stubFetch();
    // `null` / `0` / `""` are defined bodies — only `undefined` means no body.
    await authedFetch(
      { headers: {} },
      { url: "https://api.example.com/x", method: "POST", body: null },
    );
    const { init } = calls[0]!;
    assert.equal(init?.body, JSON.stringify(null));
    assert.equal((init!.headers as Record<string, string>)["Content-Type"], "application/json");
  });

  test("redirect defaults to follow and is overridable to manual", async () => {
    const { calls } = stubFetch();
    await authedFetch({ headers: {} }, { url: "https://api.example.com/a" });
    assert.equal(calls[0]!.init?.redirect, "follow");

    await authedFetch(
      { headers: {}, redirect: "manual" },
      { url: "https://api.example.com/b", method: "POST", body: {} },
    );
    assert.equal(calls[1]!.init?.redirect, "manual");
  });

  test("always attaches an abort signal (the shared timeout)", async () => {
    const { calls } = stubFetch();
    await authedFetch({ headers: {} }, { url: "https://api.example.com/a" });
    assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
    // Sanity-check the single-sourced default is a real positive duration.
    assert.equal(typeof INTEGRATION_FETCH_TIMEOUT_MS, "number");
    assert.ok(INTEGRATION_FETCH_TIMEOUT_MS > 0);
  });

  test("returns the underlying Response untouched (non-2xx does not throw)", async () => {
    const response = new Response("nope", { status: 404 });
    stubFetch(response);
    const res = await authedFetch({ headers: {} }, { url: "https://api.example.com/missing" });
    assert.equal(res, response);
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  });

  test("accepts a URL object as the request input", async () => {
    const { calls } = stubFetch();
    const url = new URL("https://api.example.com/things?limit=5");
    await authedFetch({ headers: {} }, { url });
    assert.equal(calls[0]!.input, url);
  });
});
