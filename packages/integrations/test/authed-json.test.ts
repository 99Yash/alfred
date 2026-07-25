import { HttpError } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { authedJson } from "../src/shared/authed-json";

/**
 * `authedJson` is the JSON layer built on `authedFetch` that Notion, Vercel, and
 * Google collapsed onto: *a non-2xx is an `HttpError`, a 2xx is parsed JSON.*
 * These pin that post-fetch contract — parse on success, empty body → `{}`, the
 * default `HttpError` mapping (provider/status/redacted label), and the
 * `bodyPolicy: "omit"` posture Notion uses. It stubs the global `fetch`, so it
 * runs offline.
 */

const realFetch = globalThis.fetch;

function stubFetch(response: Response): {
  // Recorded as `fetch` received it: a call made without an `init` records a
  // present `undefined`, so the declaration says `| undefined` rather than
  // claiming the key is absent.
  calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }>;
} {
  const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
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

  test('bodyPolicy "omit" keeps the status but strips the upstream body', async () => {
    stubFetch(new Response("secret page fragment", { status: 403 }));
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      await assert.rejects(
        authedJson(
          { headers: {} },
          { url: "https://api.example.com/forbidden", method: "POST" },
          { provider: "notion-like", urlLabel: "/v1/pages/x", bodyPolicy: "omit" },
        ),
        (err: unknown) => {
          assert.ok(err instanceof HttpError);
          // The structured error still carries everything a caller branches on…
          assert.equal(err.provider, "notion-like");
          assert.equal(err.status, 403);
          assert.equal(err.url, "/v1/pages/x");
          // …but the upstream body does not ride along into telemetry.
          assert.equal(err.body, "");
          return true;
        },
      );
    } finally {
      console.error = realError;
    }
    // The body survives exactly one place: the server-side log.
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /secret page fragment/);
    assert.match(logged[0] ?? "", /\[notion-like\] 403 POST \/v1\/pages\/x/);
  });

  test('a 2xx never logs or strips anything under bodyPolicy "omit"', async () => {
    stubFetch(new Response(JSON.stringify({ fine: true }), { status: 200 }));
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      const body = await authedJson(
        { headers: {} },
        { url: "https://api.example.com/ok" },
        { provider: "example", bodyPolicy: "omit" },
      );
      assert.deepEqual(body, { fine: true });
    } finally {
      console.error = realError;
    }
    assert.deepEqual(logged, []);
  });
});
