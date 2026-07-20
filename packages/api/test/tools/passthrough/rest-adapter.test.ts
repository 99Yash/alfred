import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RestPassthroughRequest } from "@alfred/contracts";
import type { RestPassthroughProfile } from "@alfred/integrations/shared";
import { runRestPassthrough } from "../../../src/modules/tools/passthrough";

/**
 * The shared REST passthrough adapter composes the whole security boundary for a
 * raw REST read: gate (method/path proven a read) → pinned-authority transport →
 * honest envelope. Transport is mocked at `globalThis.fetch` (the one primitive
 * `restPassthroughFetch` uses), so every outcome is asserted without a real
 * provider. The adapter must NEVER throw — every path returns a PassthroughResult.
 */

interface FetchCapture {
  url: URL | undefined;
  init: RequestInit | undefined;
}

async function withMockedFetch<T>(
  handler: (capture: FetchCapture) => Response | Promise<Response>,
  run: (capture: FetchCapture) => Promise<T>,
): Promise<T> {
  const capture: FetchCapture = { url: undefined, init: undefined };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    capture.url = input instanceof URL ? input : new URL(String(input));
    capture.init = init;
    return handler(capture);
  }) as typeof fetch;
  try {
    return await run(capture);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GITHUB_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://api.github.com",
  headers: { Authorization: "Bearer gh-token", Accept: "application/vnd.github+json" },
};
const NOTION_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://api.notion.com/v1",
  headers: { Authorization: "Bearer notion-token", "Notion-Version": "2022-06-28" },
};
const VERCEL_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://api.vercel.com",
  headers: { Authorization: "Bearer vercel-token" },
  fixedQuery: { teamId: "team_pinned" },
};

const req = (r: Partial<RestPassthroughRequest> & { method: string; path: string }) =>
  r as RestPassthroughRequest;

describe("runRestPassthrough — gate denial (never leaves Alfred)", () => {
  test("a write method (DELETE) is a visible rejected envelope, no fetch issued", async () => {
    let fetched = false;
    const result = await withMockedFetch(
      () => {
        fetched = true;
        return jsonResponse({});
      },
      () =>
        runRestPassthrough("github", GITHUB_PROFILE, req({ method: "DELETE", path: "/repos/a/b" })),
    );
    assert.equal(fetched, false, "gate must short-circuit before any network call");
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.reason, "method_not_read");
  });

  test("an unlisted github POST is rejected (path_not_allowlisted), no fetch issued", async () => {
    let fetched = false;
    const result = await withMockedFetch(
      () => {
        fetched = true;
        return jsonResponse({});
      },
      () =>
        runRestPassthrough(
          "github",
          GITHUB_PROFILE,
          req({ method: "POST", path: "/repos/a/b/issues", body: { title: "x" } }),
        ),
    );
    assert.equal(fetched, false);
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.reason, "path_not_allowlisted");
  });
});

describe("runRestPassthrough — HTTP envelope", () => {
  test("a clean 200 JSON is succeeded:true and carries the body + reaches the pinned URL with query", async () => {
    const result = await withMockedFetch(
      (capture) => {
        assert.equal(capture.url?.origin, "https://api.github.com");
        assert.equal(capture.url?.pathname, "/repos/a/b/commits");
        assert.equal(capture.url?.searchParams.get("per_page"), "5");
        assert.equal(capture.url?.searchParams.get("sha"), "main");
        assert.equal(capture.init?.method, "GET");
        return jsonResponse([{ sha: "abc" }]);
      },
      () =>
        runRestPassthrough(
          "github",
          GITHUB_PROFILE,
          req({ method: "GET", path: "/repos/a/b/commits", query: { per_page: 5, sha: "main" } }),
        ),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.status, 200);
      assert.equal(result.succeeded, true);
      assert.deepEqual(result.body, [{ sha: "abc" }]);
    }
  });

  test("a pinned fixedQuery (Vercel teamId) cannot be overridden by the model's own query", async () => {
    // Threat model: an injected `query.teamId` must not repoint the request at
    // another team. The profile's authority parameter wins.
    const result = await withMockedFetch(
      (capture) => {
        assert.equal(
          capture.url?.searchParams.get("teamId"),
          "team_pinned",
          "the profile-pinned teamId must survive a model-supplied collision",
        );
        assert.equal(capture.url?.searchParams.get("limit"), "20");
        return jsonResponse({ projects: [] });
      },
      () =>
        runRestPassthrough(
          "vercel",
          VERCEL_PROFILE,
          req({
            method: "GET",
            path: "/v9/projects",
            query: { teamId: "team_attacker", limit: 20 },
          }),
        ),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") assert.equal(result.succeeded, true);
  });

  test("a 404 is honest: succeeded:false with the real status and the API error body preserved", async () => {
    const result = await withMockedFetch(
      () => jsonResponse({ message: "Not Found" }, 404),
      () =>
        runRestPassthrough("github", GITHUB_PROFILE, req({ method: "GET", path: "/repos/a/nope" })),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.status, 404);
      assert.equal(result.succeeded, false);
      assert.deepEqual(result.body, { message: "Not Found" });
    }
  });

  test("a Notion read-via-POST (/search) passes the gate and issues the fetch with the body", async () => {
    let fetched = false;
    const result = await withMockedFetch(
      (capture) => {
        fetched = true;
        assert.equal(capture.init?.method, "POST");
        assert.equal(capture.init?.body, JSON.stringify({ query: "roadmap" }));
        return jsonResponse({ results: [] });
      },
      () =>
        runRestPassthrough(
          "notion",
          NOTION_PROFILE,
          req({ method: "POST", path: "/search", body: { query: "roadmap" } }),
        ),
    );
    assert.equal(fetched, true, "an allowlisted read-via-POST must reach the network");
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") assert.equal(result.succeeded, true);
  });

  test("a 3xx is succeeded:false with the Location redacted to origin+path (no query)", async () => {
    const result = await withMockedFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://downloads.example.com/blob?sig=SECRET&exp=123" },
        }),
      () =>
        runRestPassthrough(
          "github",
          GITHUB_PROFILE,
          req({ method: "GET", path: "/repos/a/b/tarball" }),
        ),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.status, 302);
      assert.equal(result.succeeded, false);
      assert.deepEqual(result.body, {
        redirect: true,
        location: "https://downloads.example.com/blob",
      });
      assert.ok(!JSON.stringify(result.body).includes("SECRET"), "signed query must be redacted");
    }
  });

  test("a binary response is represented by content type + byte count, succeeded:false, no bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await withMockedFetch(
      () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } }),
      () =>
        runRestPassthrough(
          "github",
          GITHUB_PROFILE,
          req({ method: "GET", path: "/repos/a/b/logo" }),
        ),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.succeeded, false);
      assert.deepEqual(result.body, {
        binary: true,
        contentType: "image/png",
        byteCount: png.byteLength,
        note: "Binary response omitted from the transcript. Use a curated download/export tool for the bytes.",
      });
    }
  });
});

describe("runRestPassthrough — failure classification (never throws)", () => {
  test("a timeout is a retryable transport envelope, not an http one", async () => {
    const result = await withMockedFetch(
      () => {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        throw err;
      },
      () =>
        runRestPassthrough("github", GITHUB_PROFILE, req({ method: "GET", path: "/repos/a/b" })),
    );
    assert.equal(result.outcome, "transport");
    if (result.outcome === "transport") {
      assert.equal(result.kind, "timeout");
      assert.equal(result.retryable, true);
    }
  });

  test("a URL that escapes the pinned namespace is a fail-closed invalid_path rejection", async () => {
    // A namespace-relative path cannot escape (the gate hardens `..`, encoded
    // slashes, etc.), so force the transport's defense-in-depth check by pinning
    // a namespaced base and a path that lands outside it. `/v2/...` is outside
    // Notion's `/v1` namespace once resolved.
    let fetched = false;
    const escaping: RestPassthroughProfile = {
      baseUrl: "https://api.notion.com/v1",
      headers: {},
    };
    const result = await withMockedFetch(
      () => {
        fetched = true;
        return jsonResponse({});
      },
      () => runRestPassthrough("notion", escaping, req({ method: "GET", path: "/../v2/pages" })),
    );
    // The gate rejects `..` first — the request never reaches the transport.
    assert.equal(fetched, false);
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.reason, "invalid_path");
  });
});
