import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractSenderContext } from "../../src/modules/triage/sender-context";

describe("extractSenderContext", () => {
  test("recognizes CodeRabbit GitHub body actors", () => {
    const result = extractSenderContext({
      fromHeader: "CodeRabbit <noreply@github.com>",
      subject: "Re: [acme/repo] PR #42",
      body:
        "**coderabbitai** commented on this pull request.\n\n" +
        "Consider simplifying this branch.",
    });

    assert.equal(result.context.fromKind, "service");
    assert.equal(result.context.effectiveAuthor, "bot");
    assert.equal(result.context.botSlug, "coderabbit");
    assert.equal(result.parserHit, "github");
  });

  test("recognizes severity-suspect service senders", () => {
    const result = extractSenderContext({
      fromHeader: "Sentry <alerts@sentry.io>",
      subject: "Errors spiking in production",
      body: "Your project is seeing a spike in 500s.",
    });

    assert.equal(result.context.fromKind, "service");
    assert.equal(result.context.effectiveAuthor, "bot");
    assert.equal(result.context.botSlug, "sentry");
  });

  test("keeps public brand event senders as service/unknown without meeting inference", () => {
    const result = extractSenderContext({
      fromHeader: "Apple <News@insideapple.apple.com>",
      subject: "See you next week.",
      body: "WWDC26\nWatch the keynote next week.\nUnsubscribe",
    });

    assert.equal(result.context.effectiveAuthor, "unknown");
    assert.equal(result.context.botSlug, undefined);
    assert.equal(result.parserHit, null);
  });
});
