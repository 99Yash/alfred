import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SenderContext } from "@alfred/contracts";
import {
  applyTriageClassificationGuardrails,
  type TriageClassification,
} from "../../src/modules/triage/classify";

describe("applyTriageClassificationGuardrails", () => {
  test("demotes Apple WWDC public event blasts from meeting to marketing", () => {
    const result = applyTriageClassificationGuardrails(meetingClassification(), {
      id: "doc_wwdc",
      title: "See you next week.",
      content: "WWDC26\nAll systems glow.\nWatch the keynote next week.\nUnsubscribe",
      authoredAt: new Date("2026-06-02T11:14:00.000Z"),
      metadata: {
        from: "Apple <News@insideapple.apple.com>",
        labelIds: ["INBOX"],
        snippet: "WWDC26 All systems glow.",
      },
    });

    assert.equal(result.category, "marketing");
    assert.match(result.rationale, /public brand event/i);
  });

  test("demotes shareholder AGM notices from meeting to fyi", () => {
    const result = applyTriageClassificationGuardrails(meetingClassification(), {
      id: "doc_agm",
      title:
        "SUNDRAM FASTENERS LIMITED - 63rd Annual General Meeting to be held on Wednesday, June 24, 2026",
      content:
        "Dear Shareholder,\nThe Notice and Annual Report can be downloaded from the following links.",
      authoredAt: new Date("2026-06-02T10:28:00.000Z"),
      metadata: {
        from: "evoting@nsdl.com",
        labelIds: ["INBOX"],
      },
    });

    assert.equal(result.category, "fyi");
    assert.match(result.rationale, /shareholder\/legal notice/i);
  });

  test("keeps direct shareholder voting deadlines actionable", () => {
    const result = applyTriageClassificationGuardrails(meetingClassification(), {
      id: "doc_vote",
      title: "Proxy voting closes tomorrow",
      content: "Dear Shareholder, please vote by June 20. Cast your vote before the deadline.",
      authoredAt: new Date("2026-06-02T10:28:00.000Z"),
      metadata: {
        from: "evoting@nsdl.com",
        labelIds: ["INBOX"],
      },
    });

    assert.equal(result.category, "action_needed");
    assert.match(result.rationale, /concrete user action/i);
  });

  test("leaves real user meetings as meeting", () => {
    const classification = meetingClassification();
    const result = applyTriageClassificationGuardrails(classification, {
      id: "doc_meeting",
      title: "Design review moved to 3pm",
      content: "Can you attend? Here's the updated agenda for our design review.",
      authoredAt: new Date("2026-06-02T10:28:00.000Z"),
      metadata: {
        from: "Ada Lovelace <ada@example.com>",
        labelIds: ["INBOX"],
      },
    });

    assert.deepEqual(result, classification);
  });

  test("demotes non-severe review bot comments from action needed to fyi", () => {
    const result = applyTriageClassificationGuardrails(
      {
        category: "action_needed",
        confidence: 0.9,
        rationale: "The bot suggested code changes.",
      },
      {
        id: "doc_coderabbit",
        title: "CodeRabbit commented on PR #42",
        content:
          "**coderabbitai** commented on this pull request.\n\n" +
          "Consider extracting this repeated condition into a helper for readability.",
        authoredAt: new Date("2026-06-02T10:28:00.000Z"),
        metadata: {
          from: "CodeRabbit <noreply@github.com>",
          labelIds: ["INBOX"],
        },
      },
      coderabbitSenderContext(),
    );

    assert.equal(result.category, "fyi");
    assert.match(result.rationale, /advisory/i);
  });

  test("keeps severe review bot findings actionable", () => {
    const classification: TriageClassification = {
      category: "urgent",
      confidence: 0.9,
      rationale: "The bot found an exposed API key.",
    };
    const result = applyTriageClassificationGuardrails(
      classification,
      {
        id: "doc_coderabbit_secret",
        title: "CodeRabbit commented on PR #42",
        content:
          "**coderabbitai** commented on this pull request.\n\n" +
          "A private API key appears to be exposed in this diff and should be rotated today.",
        authoredAt: new Date("2026-06-02T10:28:00.000Z"),
        metadata: {
          from: "CodeRabbit <noreply@github.com>",
          labelIds: ["INBOX"],
        },
      },
      coderabbitSenderContext(),
    );

    assert.deepEqual(result, classification);
  });
});

function meetingClassification(): TriageClassification {
  return {
    category: "meeting",
    confidence: 0.91,
    rationale: "The model treated the email as a meeting.",
  };
}

function coderabbitSenderContext(): SenderContext {
  return {
    fromKind: "service",
    effectiveAuthor: "bot",
    bodyActor: { kind: "person", name: "coderabbitai", handle: "coderabbitai" },
    botSlug: "coderabbit",
  };
}
