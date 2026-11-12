import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RestPassthroughRequest, SupportedRestSlug } from "@alfred/contracts";
import {
  restPassthroughFetch,
  type RestPassthroughCapability,
  type RestPassthroughProfile,
} from "@alfred/integrations/shared";
import { runRestPassthrough } from "../../../../src/tool-runtime/internal/tools/passthrough";

/**
 * The REST passthrough adapter: read gate, pinned-authority transport, envelope.
 * `globalThis.fetch` is mocked. The adapter must never throw.
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
  globalThis.fetch = async (input, init) => {
    capture.url =
      input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
    capture.init = init;

    return handler(capture);
  };

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

const GMAIL_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://gmail.googleapis.com/gmail/v1",
  headers: { Authorization: "Bearer gmail-token" },
};

const CALENDAR_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://www.googleapis.com/calendar/v3",
  headers: { Authorization: "Bearer calendar-token" },
};

const VERCEL_PROFILE: RestPassthroughProfile = {
  baseUrl: "https://api.vercel.com",
  headers: { Authorization: "Bearer vercel-token" },
  fixedQuery: { teamId: "team_pinned" },
};

const req = (
  r: Partial<RestPassthroughRequest> & { method: string; path: string },
): RestPassthroughRequest => r;

const capability = (
  slug: SupportedRestSlug,
  profile: RestPassthroughProfile,
): RestPassthroughCapability => ({
  slug,
  execute: (request) => restPassthroughFetch(profile, request),
});

describe("runRestPassthrough — gate denial (never leaves Alfred)", () => {
  test("a write method (DELETE) is a visible rejected envelope, no fetch issued", async () => {
    let fetched = false;

    const result = await withMockedFetch(
      () => {
        fetched = true;

        return jsonResponse({});
      },
      () =>
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({ method: "DELETE", path: "/users/me/messages/m1" }),
        ),
    );

    assert.equal(fetched, false, "gate must short-circuit before any network call");
    assert.equal(result.outcome, "rejected");

    assert.equal(result.reason, "method_not_read");
  });

  test("an unlisted gmail POST is rejected (path_not_allowlisted), no fetch issued", async () => {
    let fetched = false;

    const result = await withMockedFetch(
      () => {
        fetched = true;

        return jsonResponse({});
      },
      () =>
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({ method: "POST", path: "/users/me/messages/send", body: { raw: "x" } }),
        ),
    );

    assert.equal(fetched, false);
    assert.equal(result.outcome, "rejected");

    assert.equal(result.reason, "path_not_allowlisted");
  });
});

describe("runRestPassthrough — HTTP envelope", () => {
  test("a clean 200 JSON is succeeded:true and carries the body + reaches the pinned URL with query", async () => {
    const result = await withMockedFetch(
      (capture) => {
        assert.equal(capture.url?.origin, "https://gmail.googleapis.com");
        assert.equal(capture.url.pathname, "/gmail/v1/users/me/messages");
        assert.equal(capture.url.searchParams.get("maxResults"), "5");
        assert.equal(capture.url.searchParams.get("q"), "in:inbox");
        assert.equal(capture.init?.method, "GET");

        return jsonResponse([{ id: "abc" }]);
      },
      () =>
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({
            method: "GET",
            path: "/users/me/messages",
            query: { maxResults: 5, q: "in:inbox" },
          }),
        ),
    );

    assert.equal(result.outcome, "http");

    assert.equal(result.status, 200);
    assert.equal(result.succeeded, true);
    assert.deepEqual(result.body, [{ id: "abc" }]);
  });

  test("a pinned fixedQuery (Vercel teamId) cannot be overridden by the model's own query", async () => {
    // An injected `query.teamId` must not point the request at another team.
    const result = await withMockedFetch(
      (capture) => {
        assert.equal(
          capture.url?.searchParams.get("teamId"),
          "team_pinned",
          "the profile-pinned teamId must survive a model-supplied collision",
        );
        assert.equal(capture.url.searchParams.get("limit"), "20");

        return jsonResponse({ projects: [] });
      },
      () =>
        runRestPassthrough(
          capability("vercel", VERCEL_PROFILE),
          req({
            method: "GET",
            path: "/v9/projects",
            query: { teamId: "team_attacker", limit: 20 },
          }),
        ),
    );

    assert.equal(result.outcome, "http");

    assert.equal(result.succeeded, true);
  });

  test("a 404 is honest: succeeded:false with the real status and the API error body preserved", async () => {
    const result = await withMockedFetch(
      () => jsonResponse({ message: "Not Found" }, 404),
      () =>
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({ method: "GET", path: "/users/me/messages/nope" }),
        ),
    );

    assert.equal(result.outcome, "http");

    assert.equal(result.status, 404);
    assert.equal(result.succeeded, false);
    assert.deepEqual(result.body, { message: "Not Found" });
  });

  test("a Calendar read-via-POST (/freeBusy) passes the gate and issues the fetch with the body", async () => {
    let fetched = false;

    const result = await withMockedFetch(
      (capture) => {
        fetched = true;
        assert.equal(capture.init?.method, "POST");
        assert.equal(capture.init.body, JSON.stringify({ items: [{ id: "primary" }] }));

        return jsonResponse({ calendars: {} });
      },
      () =>
        runRestPassthrough(
          capability("calendar", CALENDAR_PROFILE),
          req({ method: "POST", path: "/freeBusy", body: { items: [{ id: "primary" }] } }),
        ),
    );

    assert.equal(fetched, true, "an allowlisted read-via-POST must reach the network");
    assert.equal(result.outcome, "http");

    assert.equal(result.succeeded, true);
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
          capability("gmail", GMAIL_PROFILE),
          req({ method: "GET", path: "/users/me/messages/m1/attachments/a1" }),
        ),
    );

    assert.equal(result.outcome, "http");

    assert.equal(result.status, 302);
    assert.equal(result.succeeded, false);
    assert.deepEqual(result.body, {
      redirect: true,
      location: "https://downloads.example.com/blob",
    });
    assert.ok(!JSON.stringify(result.body).includes("SECRET"), "signed query must be redacted");
  });

  test("a binary response is represented by content type + byte count, succeeded:false, no bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const result = await withMockedFetch(
      () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } }),
      () =>
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({ method: "GET", path: "/users/me/messages/m1/attachments/a2" }),
        ),
    );

    assert.equal(result.outcome, "http");

    assert.equal(result.succeeded, false);
    assert.deepEqual(result.body, {
      binary: true,
      contentType: "image/png",
      byteCount: png.byteLength,
      note: "Binary response omitted from the transcript. Use a curated download/export tool for the bytes.",
    });
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
        runRestPassthrough(
          capability("gmail", GMAIL_PROFILE),
          req({ method: "GET", path: "/users/me/profile" }),
        ),
    );

    assert.equal(result.outcome, "transport");

    assert.equal(result.kind, "timeout");
    assert.equal(result.retryable, true);
  });

  test("a URL that escapes the pinned namespace is a fail-closed invalid_path rejection", async () => {
    // The gate already blocks `..`, so this forces the transport's own check: `/v4` is outside
    // Calendar's `/calendar/v3`.
    let fetched = false;

    const escaping: RestPassthroughProfile = {
      baseUrl: "https://www.googleapis.com/calendar/v3",
      headers: {},
    };

    const result = await withMockedFetch(
      () => {
        fetched = true;

        return jsonResponse({});
      },
      () =>
        runRestPassthrough(
          capability("calendar", escaping),
          req({ method: "GET", path: "/../v4/calendars" }),
        ),
    );

    assert.equal(fetched, false);
    assert.equal(result.outcome, "rejected");

    assert.equal(result.reason, "invalid_path");
  });
});
