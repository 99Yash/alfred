import { redacted } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createGithubClient } from "../src/github/client";

/**
 * The token goes only into `Authorization`, never into a URL or an error.
 * `passthrough` is opaque, so tools never see auth headers. `getIssue` caps the body and reads both label shapes.
 * `createGithubClient` takes the resolver directly, so no DB and no memo hides the resolve count.
 */

const realFetch = globalThis.fetch;

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(onResolve?: () => void) {
  return createGithubClient({
    resolveToken: async () => {
      onResolve?.();

      return { token: redacted("ghs_secret_token"), accountLogin: "99Yash" };
    },
    retry: "none",
  });
}

const ISSUE = {
  number: 7,
  title: "A bug",
  html_url: "https://github.com/o/r/issues/7",
  state: "open",
  created_at: "2026-07-01T00:00:00Z",
  closed_at: null,
  user: { login: "99Yash" },
  comments: 3,
  body: "the body",
  labels: [{ name: "bug" }, "regression", { name: undefined }],
  repository_url: "https://api.github.com/repos/o/r",
};

describe("github client auth", () => {
  test("unwraps the token only into the Authorization header", async () => {
    const calls = stubFetch({ ...ISSUE });
    await client().getIssue({ owner: "o", repo: "r", number: 7 });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.headers.Authorization, "Bearer ghs_secret_token");
    // URLs reach logs and errors.
    assert.ok(!call.url.includes("ghs_secret_token"));
    assert.equal(call.url, "https://api.github.com/repos/o/r/issues/7");
  });

  test("a non-2xx error carries the redacted label, never the token", async () => {
    stubFetch({ message: "Not Found" }, 404);
    await assert.rejects(
      client().getIssue({ owner: "o", repo: "r", number: 7 }),
      (err: unknown) => {
        const text = JSON.stringify(err) + String(err);
        assert.ok(!text.includes("ghs_secret_token"), "the token must not reach the error");

        return true;
      },
    );
  });

  test("passthrough is an opaque capability and keeps auth inside integrations", async () => {
    const calls = stubFetch({ ok: true });
    const passthrough = client().passthrough;
    assert.equal(passthrough.slug, "github");
    assert.deepEqual(Object.keys(passthrough).sort(), ["execute", "slug"]);
    await passthrough.execute({ method: "GET", path: "/repos/o/r", query: {} });
    assert.equal(calls[0]?.headers.Authorization, "Bearer ghs_secret_token");
    assert.equal(calls[0]?.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(calls[0]?.headers["User-Agent"], "alfred-app");
  });

  test("resolves per request — no client memoizes a credential", async () => {
    stubFetch({ ...ISSUE });
    let resolves = 0;

    const gh = client(() => {
      resolves += 1;
    });

    await gh.connectedLogin();
    await gh.getIssue({ owner: "o", repo: "r", number: 7 });
    // One resolve per call, so no client caches a token.
    assert.equal(resolves, 2, "a client must not cache its credential");
  });
});

describe("github client getIssue", () => {
  test("normalizes GitHub's object-or-string labels and drops unnamed ones", async () => {
    stubFetch({ ...ISSUE });
    const issue = await client().getIssue({ owner: "o", repo: "r", number: 7 });
    assert.deepEqual(issue.labels, ["bug", "regression"]);
    assert.equal(issue.repository, "o/r");
    assert.equal(issue.author, "99Yash");
    assert.equal(issue.comments, 3);
  });

  test("caps the inlined body so one huge issue cannot blow up the caller", async () => {
    stubFetch({ ...ISSUE, body: "x".repeat(50_000) });
    const issue = await client().getIssue({ owner: "o", repo: "r", number: 7 });
    assert.equal(issue.body.length, 20_000);
  });

  test("a null body becomes an empty string, not the string 'null'", async () => {
    stubFetch({ ...ISSUE, body: null, comments: undefined, labels: undefined });
    const issue = await client().getIssue({ owner: "o", repo: "r", number: 7 });
    assert.equal(issue.body, "");
    assert.equal(issue.comments, 0);
    assert.deepEqual(issue.labels, []);
  });
});
