import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GraphqlPassthroughRequest } from "@alfred/contracts";
import { runRailwayPassthrough } from "../../../src/modules/tools/passthrough";

/**
 * The Railway passthrough adapter composes the whole security boundary for a raw
 * Railway GraphQL read: gate (AST proves query-only) → raw transport → honest
 * envelope. Transport is mocked at `globalThis.fetch` (the one primitive
 * `railwayGraphqlRaw` uses), so every outcome is asserted without a real
 * provider. The adapter must NEVER throw — every path returns a PassthroughResult.
 */

async function withMockedFetch<T>(
  handler: (init: RequestInit | undefined) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => handler(init)) as typeof fetch;
  try {
    return await run();
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

const query = (document: string): GraphqlPassthroughRequest => ({ document });

describe("runRailwayPassthrough — gate denial (never leaves Alfred)", () => {
  test("a mutation is a visible rejected envelope, no fetch issued", async () => {
    let fetched = false;
    const result = await withMockedFetch(
      () => {
        fetched = true;
        return jsonResponse({});
      },
      () => runRailwayPassthrough("tok", query("mutation { deleteService(id: 1) { id } }")),
    );
    assert.equal(fetched, false, "gate must short-circuit before any network call");
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.reason, "graphql_non_query");
  });
});

describe("runRailwayPassthrough — HTTP envelope", () => {
  test("a clean 200 with data is succeeded:true and carries the body", async () => {
    const result = await withMockedFetch(
      () => jsonResponse({ data: { me: { id: "u1" } } }),
      () => runRailwayPassthrough("tok", query("query { me { id } }")),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.status, 200);
      assert.equal(result.succeeded, true);
      assert.deepEqual(result.body, { data: { me: { id: "u1" } } });
    }
  });

  test("a partial (HTTP 200 with data AND errors[]) is succeeded:false yet keeps the partial data", async () => {
    const body = {
      data: { me: { id: "u1" } },
      errors: [{ message: "field x not found" }],
    };
    const result = await withMockedFetch(
      () => jsonResponse(body),
      () => runRailwayPassthrough("tok", query("query { me { id } x }")),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      // Real HTTP status is 200 even though the read partially failed.
      assert.equal(result.status, 200);
      assert.equal(result.succeeded, false, "any errors[] fails the read");
      // The partial data must survive so the model can read both.
      assert.deepEqual(result.body, body);
    }
  });

  test("a non-2xx (e.g. 500) is honest: succeeded:false with the real status and body", async () => {
    const result = await withMockedFetch(
      () => jsonResponse({ errors: [{ message: "server error" }] }, 500),
      () => runRailwayPassthrough("tok", query("query { me { id } }")),
    );
    assert.equal(result.outcome, "http");
    if (result.outcome === "http") {
      assert.equal(result.status, 500);
      assert.equal(result.succeeded, false);
    }
  });
});

describe("runRailwayPassthrough — transport failure classification", () => {
  test("a timeout/abort is a retryable transport envelope, not an http one", async () => {
    const result = await withMockedFetch(
      () => {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        throw err;
      },
      () => runRailwayPassthrough("tok", query("query { me { id } }")),
    );
    assert.equal(result.outcome, "transport");
    if (result.outcome === "transport") {
      assert.equal(result.kind, "timeout");
      assert.equal(result.retryable, true);
    }
  });

  test("a DNS failure (ENOTFOUND) is a non-retryable transport envelope", async () => {
    const result = await withMockedFetch(
      () => {
        const err = new Error("fetch failed");
        (err as unknown as { cause: { code: string } }).cause = { code: "ENOTFOUND" };
        throw err;
      },
      () => runRailwayPassthrough("tok", query("query { me { id } }")),
    );
    assert.equal(result.outcome, "transport");
    if (result.outcome === "transport") {
      assert.equal(result.kind, "dns");
      assert.equal(result.retryable, false);
    }
  });
});
