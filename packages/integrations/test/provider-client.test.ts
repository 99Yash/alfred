import { HttpError } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { defineProviderClient } from "../src/shared/provider-client";
import { isRetrySafeMethod } from "../src/shared/retry";

/**
 * `defineProviderClient` is the configured-client seam every provider builds on.
 * These pin the two hazards it absorbs — hazards a shared seam must enforce in
 * its types rather than describe in its docstring:
 *
 *   1. transient retry follows the METHOD, not the provider's retry envelope, so
 *      a POST is never silently re-sent;
 *   2. `bodyPolicy` is a REQUIRED config field, so a body-sensitive provider joins
 *      by stating its posture rather than hand-rolling the omit one — and cannot
 *      inherit a leak by omitting the field.
 *
 * Plus the mechanics the seam owns: fresh auth per request, pinned query that a
 * caller cannot override, and JSON parsed as `unknown`. It stubs the global
 * `fetch`, so it runs offline.
 */

const realFetch = globalThis.fetch;

interface RecordedStubFetch {
  urls: string[];
  methods: string[];
}

function stubFetch(respond: (n: number) => Response): RecordedStubFetch {
  const urls: string[] = [];
  const methods: string[] = [];
  let n = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    methods.push(String(init?.method ?? "GET"));
    n += 1;
    return Promise.resolve(respond(n));
  }) as typeof fetch;
  return { urls, methods };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(overrides: Partial<Parameters<typeof defineProviderClient>[0]> = {}) {
  return defineProviderClient({
    provider: "example",
    baseUrl: "https://api.example.com",
    resolve: async () => ({ headers: { Authorization: "Bearer tok" } }),
    // A zero backoff keeps the retry assertions fast without changing the count.
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    bodyPolicy: "summarize",
    ...overrides,
  });
}

describe("isRetrySafeMethod", () => {
  test("admits only the RFC 9110 safe methods", () => {
    for (const m of [undefined, "GET", "get", "HEAD", "OPTIONS"]) {
      assert.equal(isRetrySafeMethod(m), true, `${String(m)} should be retry-safe`);
    }
    // Idempotent (PUT/DELETE) is deliberately NOT enough — a repeat leaves the
    // same state but answers a different status, which a caller may read.
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.equal(isRetrySafeMethod(m), false, `${m} should not be retry-safe`);
    }
  });
});

describe("defineProviderClient", () => {
  test("a GET retries a transient 500 up to the policy budget", async () => {
    const calls = stubFetch((n) =>
      n < 3 ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ ok: true })),
    );
    const body = await client().json("/thing");
    assert.deepEqual(body, { ok: true });
    assert.equal(calls.methods.length, 3);
  });

  test('retry: "none" sends exactly one attempt for a retry-safe GET', async () => {
    // "Off" has to be a value the config can hold. When it was expressed by
    // omitting an optional field, this was the unwritable case: absence meant the
    // built-in 3-attempt policy, so a provider retried by accident.
    const calls = stubFetch(() => new Response("nope", { status: 500 }));
    await assert.rejects(client({ retry: "none" }).json("/thing"), HttpError);
    assert.equal(calls.methods.length, 1);
  });

  test("a POST is NEVER retried, even with a retry envelope configured", async () => {
    const calls = stubFetch(() => new Response("upstream broke", { status: 500 }));
    await assert.rejects(client().json("/thing", { method: "POST", body: { a: 1 } }), HttpError);
    // One attempt only: a write that may already have landed is not re-sent.
    assert.equal(calls.methods.length, 1);
  });

  test("a non-safe method opts into retry explicitly with idempotent: true", async () => {
    const calls = stubFetch((n) =>
      n < 2 ? new Response("nope", { status: 503 }) : new Response(JSON.stringify({ ok: 1 })),
    );
    const body = await client().json("/thing", { method: "PUT", idempotent: true });
    assert.deepEqual(body, { ok: 1 });
    assert.equal(calls.methods.length, 2);
  });

  test('bodyPolicy "omit" strips the upstream body from the thrown error', async () => {
    stubFetch(() => new Response("page fragment that must not travel", { status: 400 }));
    const realError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        client({ bodyPolicy: "omit" }).json("/pages/x", { label: "/pages/:id" }),
        (err: unknown) => {
          assert.ok(err instanceof HttpError);
          assert.equal(err.status, 400);
          assert.equal(err.url, "/pages/:id");
          assert.equal(err.body, "");
          return true;
        },
      );
    } finally {
      console.error = realError;
    }
  });

  // `"summarize"` is not a default — the config has no default, every bind states
  // its posture. This pins what the stated bounded posture does.
  test('bodyPolicy "summarize" keeps a bounded body slice on the error', async () => {
    stubFetch(() => new Response("upstream said no", { status: 404 }));
    await assert.rejects(client().json("/thing"), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.match(err.body, /upstream said no/);
      return true;
    });
  });

  test("pinned fixedQuery wins over a caller's query of the same name", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({})));
    await client({
      resolve: async () => ({ headers: {}, fixedQuery: { teamId: "team_real" } }),
    }).json("/v10/projects", { query: { teamId: "team_spoofed", limit: 5 } });
    const url = new URL(calls.urls[0] ?? "");
    assert.equal(url.searchParams.get("teamId"), "team_real");
    assert.equal(url.searchParams.get("limit"), "5");
  });

  test("resolve() runs on every request, so nothing caches a token", async () => {
    stubFetch(() => new Response(JSON.stringify({})));
    let resolves = 0;
    const c = client({
      resolve: async () => {
        resolves += 1;
        return { headers: { Authorization: `Bearer tok_${resolves}` } };
      },
    });
    await c.json("/a");
    await c.json("/b");
    assert.equal(resolves, 2);
  });

  test("an undefined query value is dropped rather than serialized", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({})));
    await client().json("/v6/deployments", { query: { limit: 20, projectId: undefined } });
    const url = new URL(calls.urls[0] ?? "");
    assert.equal(url.searchParams.has("projectId"), false);
    assert.equal(url.searchParams.get("limit"), "20");
  });

  test("an empty body resolves to {}", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    assert.deepEqual(await client().json("/empty"), {});
  });
});
