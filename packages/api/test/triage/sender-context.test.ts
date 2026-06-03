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

  test("leaves bare single-word locals unknown instead of asserting person", () => {
    for (const local of ["evoting", "payroll", "careers", "jobs", "feedback", "sales"]) {
      const result = extractSenderContext({
        fromHeader: `${local}@example.com`,
        subject: "Update",
        body: "Plain notification body.",
      });

      assert.equal(result.context.fromKind, "unknown", local);
      assert.equal(result.context.effectiveAuthor, "unknown", local);
      assert.equal(result.context.botSlug, undefined, local);
      assert.equal(result.parserHit, null, local);
    }
  });

  test("keeps person display names as person even with bare single-word locals", () => {
    const result = extractSenderContext({
      fromHeader: "Grace Hopper <grace@example.com>",
      subject: "Question about Q3 numbers",
      body: "Could you send me the Q3 revenue breakdown?",
    });

    assert.equal(result.context.fromKind, "person");
    assert.equal(result.context.effectiveAuthor, "person");
    assert.equal(result.context.botSlug, undefined);
    assert.equal(result.parserHit, null);
  });

  test("rejects org-like spaced display names as person evidence", () => {
    const result = extractSenderContext({
      fromHeader: "National Securities Depository Limited <evoting@nsdl.com>",
      subject: "Remote e-voting closes tomorrow - cast your vote",
      body: "Please cast your vote before the remote e-voting deadline closes tomorrow.",
    });

    assert.equal(result.context.fromKind, "unknown");
    assert.equal(result.context.effectiveAuthor, "unknown");
    assert.equal(result.context.botSlug, undefined);
    assert.equal(result.parserHit, null);
  });

  test("rejects team-like spaced display names as person evidence", () => {
    const result = extractSenderContext({
      fromHeader: "Acme Billing Team <notice@acme.example>",
      subject: "Billing update",
      body: "Your invoice is ready.",
    });

    assert.equal(result.context.fromKind, "unknown");
    assert.equal(result.context.effectiveAuthor, "unknown");
    assert.equal(result.context.botSlug, undefined);
    assert.equal(result.parserHit, null);
  });

  test("keeps person-shaped locals as person", () => {
    const result = extractSenderContext({
      fromHeader: "jane.doe@example.com",
      subject: "Quick question",
      body: "Can you take a look?",
    });

    assert.equal(result.context.fromKind, "person");
    assert.equal(result.context.effectiveAuthor, "person");
    assert.equal(result.context.botSlug, undefined);
    assert.equal(result.parserHit, null);
  });
});
