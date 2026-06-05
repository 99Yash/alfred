import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  mergeHistogram,
  senderKeyFor,
  senderPriorWriteKeyFor,
} from "../../src/modules/triage/sender-priors";

describe("senderKeyFor", () => {
  test("returns null for human senders — a person's category is per-message", () => {
    assert.equal(senderKeyFor({ effectiveAuthor: "person" }, "priya@acme.com"), null);
  });

  test("keys recognized bots by slug, not the shared envelope address", () => {
    assert.equal(
      senderKeyFor({ effectiveAuthor: "bot", botSlug: "coderabbit" }, "noreply@github.com"),
      "service:coderabbit",
    );
  });

  test("keys explicit service senders by exact lowercased address", () => {
    assert.equal(
      senderKeyFor({ effectiveAuthor: "service" }, "Alerts@Stripe.com"),
      "alerts@stripe.com",
    );
  });

  test("returns null for ambiguous unknown senders even with an address", () => {
    assert.equal(senderKeyFor({ effectiveAuthor: "unknown" }, "team@example.com"), null);
  });

  test("returns null when there is no usable address and no bot slug", () => {
    assert.equal(senderKeyFor({ effectiveAuthor: "unknown" }, null), null);
  });
});

describe("senderPriorWriteKeyFor", () => {
  test("returns a key for successful service classifications", () => {
    assert.equal(
      senderPriorWriteKeyFor({
        senderContext: { effectiveAuthor: "service" },
        senderAddress: "Digest@Substack.com",
        isSent: false,
        model: "gemini-2.5-flash-lite",
      }),
      "digest@substack.com",
    );
  });

  test("skips sent mail", () => {
    assert.equal(
      senderPriorWriteKeyFor({
        senderContext: { effectiveAuthor: "service" },
        senderAddress: "me@example.com",
        isSent: true,
        model: "gemini-2.5-flash-lite",
      }),
      null,
    );
  });

  test("skips fallback classifications", () => {
    assert.equal(
      senderPriorWriteKeyFor({
        senderContext: { effectiveAuthor: "service" },
        senderAddress: "alerts@stripe.com",
        isSent: false,
        model: "fallback",
      }),
      null,
    );
  });
});

describe("mergeHistogram", () => {
  test("seeds a count of 1 for a new category", () => {
    assert.deepEqual(mergeHistogram({}, "newsletter"), { newsletter: 1 });
  });

  test("increments an existing category", () => {
    assert.deepEqual(mergeHistogram({ newsletter: 2 }, "newsletter"), { newsletter: 3 });
  });

  test("three same-sender classifications accumulate to { newsletter: 3 }", () => {
    let h: Record<string, number> = {};
    h = mergeHistogram(h, "newsletter");
    h = mergeHistogram(h, "newsletter");
    h = mergeHistogram(h, "newsletter");
    assert.deepEqual(h, { newsletter: 3 });
  });

  test("adds a distinct category without disturbing others", () => {
    assert.deepEqual(mergeHistogram({ newsletter: 5 }, "marketing"), {
      newsletter: 5,
      marketing: 1,
    });
  });

  test("does not mutate the input histogram", () => {
    const existing = { newsletter: 1 };
    mergeHistogram(existing, "newsletter");
    assert.deepEqual(existing, { newsletter: 1 });
  });
});
