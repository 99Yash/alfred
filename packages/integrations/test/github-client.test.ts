import { redacted } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createGithubClient } from "../src/github/client";

/**
 * The token goes only into `Authorization`, never into a URL or an error.
 * `createGithubClient` takes the resolver directly, so no DB and no memo hides the resolve count.
 */

const realFetch = globalThis.fetch;

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
    });

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(onResolve?: () => void) {
  return createGithubClient({
    resolveToken: async () => {
      onResolve?.();

      return { token: redacted("ghs_secret_token") };
    },
    retry: "none",
  });
}

const PULL = {
  id: 1001,
  title: "A fix",
  html_url: "https://github.com/o/r/pull/7",
  state: "closed",
  merged: true,
  merged_at: "2026-07-01T00:00:00Z",
  closed_at: "2026-07-01T00:00:00Z",
};

const ITEM = { owner: "o", repo: "r", number: 7 };

describe("github client auth", () => {
  test("unwraps the token only into the Authorization header", async () => {
    const calls = stubFetch({ ...PULL });
    await client().getPullRequests([ITEM]);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.headers.get("Authorization"), "Bearer ghs_secret_token");
    // URLs reach logs and errors.
    assert.ok(!call.url.includes("ghs_secret_token"));
    assert.equal(call.url, "https://api.github.com/repos/o/r/pulls/7");
  });

  test("a non-2xx error carries the redacted label, never the token", async () => {
    stubFetch({ message: "Not Found" }, 404);
    const batch = await client().getPullRequests([ITEM]);
    assert.equal(batch.items.length, 0);
    assert.equal(batch.failed.length, 1);
    assert.ok(
      !JSON.stringify(batch.failed).includes("ghs_secret_token"),
      "the token must not reach the error",
    );
  });

  test("resolves per request — no client memoizes a credential", async () => {
    stubFetch({ ...PULL });
    let resolves = 0;

    const gh = client(() => {
      resolves += 1;
    });

    await gh.getPullRequests([ITEM]);
    await gh.getPullRequests([ITEM]);
    // One resolve per call, so no client caches a token.
    assert.equal(resolves, 2, "a client must not cache its credential");
  });
});
