import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { senderKeyFor, senderPriorWriteKeyFor } from "../../src/modules/triage/sender-priors";

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
