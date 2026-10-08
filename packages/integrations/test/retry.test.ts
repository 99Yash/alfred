import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fetchWithRetry } from "../src/shared/retry";

/**
 * `Retry-After` comes from upstream, so it never extends the wait past `maxDelayMs`.
 * A longer delay ends the retries instead of parking a tool call for an hour.
 */

function respondWith(headers: Record<string, string>) {
  let attempts = 0;

  const send = () => {
    attempts += 1;

    return Promise.resolve(new Response("rate limited", { status: 429, headers }));
  };

  return { send, attempts: () => attempts };
}

describe("fetchWithRetry Retry-After handling", () => {
  test("bounds an oversized Retry-After by the policy ceiling", async () => {
    const upstream = respondWith({ "retry-after": "3600" });
    const started = Date.now();

    const res = await fetchWithRetry(upstream.send, {
      policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 5 },
    });

    const elapsed = Date.now() - started;
    assert.equal(res.status, 429, "the last response is returned once attempts are spent");
    assert.equal(upstream.attempts(), 3);
    // Loose bound so a slow machine cannot flake; an unbounded 3600s wait still fails.
    assert.ok(elapsed < 2_000, `expected a bounded wait, took ${elapsed}ms`);
  });

  test("honors a Retry-After that is already within the ceiling", async () => {
    const upstream = respondWith({ "retry-after": "0" });

    const res = await fetchWithRetry(upstream.send, {
      policy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1_000 },
    });

    assert.equal(res.status, 429);
    assert.equal(upstream.attempts(), 2);
  });

  test("ignores a malformed or HTTP-date Retry-After and falls back to backoff", async () => {
    for (const header of ["Wed, 21 Oct 2026 07:28:00 GMT", "not-a-number", "-5"]) {
      const upstream = respondWith({ "retry-after": header });

      const res = await fetchWithRetry(upstream.send, {
        policy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      });

      assert.equal(res.status, 429, header);
      assert.equal(upstream.attempts(), 2, header);
    }
  });
});
