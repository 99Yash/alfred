import { HttpError } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { authedJson } from "../src/shared/authed-json";

/**
 * `authedJson` is the JSON layer built on `authedFetch` that Notion, Vercel, and
 * Google collapsed onto: *a non-2xx is an `HttpError`, a 2xx is parsed JSON.*
 * These pin that post-fetch contract — parse on success, empty body → `{}`, the
 * default `HttpError` mapping (provider/status/redacted label), and the `onError`
 * override Notion uses. It stubs the global `fetch`, so it runs offline.
 */

const realFetch = globalThis.fetch;

function stubFetch(response: Response): {
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

describe("authedJson", () => {
  test("a 2xx parses the JSON body and returns it as unknown", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true, n: 2 }), { status: 200 }));
    const body = await authedJson(
      { headers: { Authorization: "Bearer tok" } },
      { url: "https://api.example.com/thing" },
      { provider: "example" },
    );
    assert.deepEqual(body, { ok: true, n: 2 });
  });

  test("a 204/empty body resolves to {}", async () => {
    stubFetch(new Response(null, { status: 200 }));
    const body = await authedJson(
      { headers: {} },
      { url: "https://api.example.com/empty" },
      { provider: "example" },
    );
    assert.deepEqual(body, {});
  });

  test("a non-2xx throws an HttpError carrying provider/status/redacted label", async () => {
    stubFetch(new Response("upstream said no", { status: 404 }));
    await assert.rejects(
      authedJson(
        { headers: {} },
        { url: "https://api.example.com/missing", method: "GET" },
        { provider: "example", urlLabel: "the/redacted/path" },
      ),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.provider, "example");
        assert.equal(err.status, 404);
        assert.equal(err.url, "the/redacted/path");
        assert.equal(err.method, "GET");
        // The bounded upstream body rides along on the default mapping.
        assert.match(err.body, /upstream said no/);
        return true;
      },
    );
  });

  test("urlLabel defaults to the request URL when omitted", async () => {
    stubFetch(new Response("boom", { status: 500 }));
    await assert.rejects(
      authedJson({ headers: {} }, { url: "https://api.example.com/x" }, { provider: "example" }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.url, "https://api.example.com/x");
        return true;
      },
    );
  });

  test("onError overrides the default non-2xx branch entirely", async () => {
    stubFetch(new Response("secret page fragment", { status: 403 }));
    class CustomError extends Error {}
    await assert.rejects(
      authedJson(
        { headers: {} },
        { url: "https://api.example.com/forbidden" },
        {
          provider: "example",
          // Notion's shape: log the body server-side, throw something body-less.
          onError: async (res) => {
            assert.equal(res.status, 403);
            throw new CustomError("mapped by onError");
          },
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof CustomError);
        // The upstream body never rode into the thrown error.
        assert.doesNotMatch(err.message, /secret page fragment/);
        return true;
      },
    );
  });

  test("a 2xx never invokes onError", async () => {
    stubFetch(new Response(JSON.stringify({ fine: true }), { status: 200 }));
    let called = false;
    const body = await authedJson(
      { headers: {} },
      { url: "https://api.example.com/ok" },
      {
        provider: "example",
        onError: async () => {
          called = true;
          throw new Error("should not run");
        },
      },
    );
    assert.deepEqual(body, { fine: true });
    assert.equal(called, false);
  });
});
