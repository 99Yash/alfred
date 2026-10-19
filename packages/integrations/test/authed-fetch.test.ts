import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  authedFetch,
  INTEGRATION_FETCH_TIMEOUT_MS,
  type AuthedFetchProfile,
} from "../src/shared/authed-fetch";

/** The wire contract of `authedFetch`, the shared transport for the curated provider clients. */

interface RecordedFetchCalls {
  calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }>;
}

const realFetch = globalThis.fetch;

/** The fetch call at `index`; fails the test with a clear message when fewer calls were made. */
function callAt(
  calls: RecordedFetchCalls["calls"],
  index: number,
): RecordedFetchCalls["calls"][number] {
  const call = calls[index];
  assert.ok(call, `expected a fetch call at index ${index}`);

  return call;
}

function stubFetch(response: Response = new Response(null, { status: 200 })): RecordedFetchCalls {
  const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });

    return Promise.resolve(response);
  };

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
    const { input, init } = callAt(calls, 0);
    assert.equal(input, "https://api.example.com/things");
    assert.equal(init?.method, "GET");
    assert.deepEqual(init.headers, { Authorization: "Bearer tok", Accept: "application/json" });
    assert.equal(init.body, undefined);
    assert.equal("Content-Type" in (init.headers as Record<string, string>), false);
  });

  test("a write: JSON-encodes the body and adds Content-Type without clobbering profile headers", async () => {
    const { calls } = stubFetch();
    await authedFetch(
      { headers: { Authorization: "Bearer tok", "Notion-Version": "2022-06-28" } },
      { url: "https://api.example.com/pages", method: "POST", body: { title: "hi", n: 1 } },
    );

    const { init } = callAt(calls, 0);
    assert.equal(init?.method, "POST");
    assert.equal(init.body, JSON.stringify({ title: "hi", n: 1 }));
    assert.deepEqual(init.headers, {
      Authorization: "Bearer tok",
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    });
  });

  test("body presence, not method, drives Content-Type (a false-y body still counts)", async () => {
    const { calls } = stubFetch();
    // Only `undefined` means no body.
    await authedFetch(
      { headers: {} },
      { url: "https://api.example.com/x", method: "POST", body: null },
    );
    const { init } = callAt(calls, 0);
    assert.equal(init?.body, JSON.stringify(null));
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  });

  test("redirect defaults to follow and is overridable to manual", async () => {
    const { calls } = stubFetch();
    await authedFetch({ headers: {} }, { url: "https://api.example.com/a" });
    assert.equal(callAt(calls, 0).init?.redirect, "follow");

    await authedFetch(
      { headers: {}, redirect: "manual" },
      { url: "https://api.example.com/b", method: "POST", body: {} },
    );
    assert.equal(callAt(calls, 1).init?.redirect, "manual");
  });

  test("always attaches an abort signal (the shared timeout)", async () => {
    const { calls } = stubFetch();
    await authedFetch({ headers: {} }, { url: "https://api.example.com/a" });
    assert.ok(callAt(calls, 0).init?.signal instanceof AbortSignal);
    assert.equal(typeof INTEGRATION_FETCH_TIMEOUT_MS, "number");
    // The literal type decides the comparison; read it as a number to pin the runtime value.
    const timeoutMs: number = INTEGRATION_FETCH_TIMEOUT_MS;
    assert.ok(timeoutMs > 0);
  });

  test("a profile cannot shorten the shared timeout", async () => {
    const { calls } = stubFetch();
    // `timeoutMs` is not on the profile type. `Object.assign` avoids both an excess-property error and a cast.
    const profile: AuthedFetchProfile = { headers: {} };
    await authedFetch(Object.assign({}, profile, { timeoutMs: 1 }), {
      url: "https://api.example.com/a",
    });

    const { init } = callAt(calls, 0);
    assert.ok(init);
    const { signal } = init;
    assert.ok(signal instanceof AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(signal.aborted, false, "profile timeoutMs must not shorten the shared timeout");
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
    assert.equal(callAt(calls, 0).input, url);
  });
});
