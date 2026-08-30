import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildGmailDocumentContent,
  extractGmailDocumentBody,
} from "@alfred/contracts/gmail-document-content";

const envelope = {
  from: "Priya <priya@example.com>",
  to: "yash@example.com",
  subject: "Project plan",
};

describe("Gmail document content", () => {
  test("round-trips the typed envelope and body", () => {
    const content = buildGmailDocumentContent({
      ...envelope,
      body: "Please review the plan.",
      date: new Date("2026-08-30T10:00:00.000Z"),
    });

    assert.equal(extractGmailDocumentBody(content, envelope), "Please review the plan.");
  });

  test("preserves header-shaped lines at the start of the real body", () => {
    for (const body of [
      "Date: September 1\nTime: 10:00\nLocation: Room 4",
      "From: the migration guide\nContinue with step two.",
    ]) {
      const content = buildGmailDocumentContent({ ...envelope, body });
      assert.equal(extractGmailDocumentBody(content, envelope), body);
    }
  });

  test("preserves raw content without a matching typed envelope", () => {
    const raw = "From: the migration guide\nSubject: parsing prose\n\nKeep this body verbatim.";
    assert.equal(extractGmailDocumentBody(raw, {}), raw);
    assert.equal(
      extractGmailDocumentBody(raw, {
        from: "Actual Sender <sender@example.com>",
        subject: "Actual subject",
      }),
      raw,
    );
  });

  test("preserves ambiguous one-field prefixes", () => {
    const raw = "From: Priya <priya@example.com>\n\nThis may be quoted body content.";
    assert.equal(extractGmailDocumentBody(raw, { from: envelope.from }), raw);
  });
});
