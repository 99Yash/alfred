import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BriefingGather } from "@alfred/contracts";

import { resolveBriefingReferences } from "../../src/modules/briefing/references";

describe("resolveBriefingReferences", () => {
  test("resolves activity placeholders from gather activity items", () => {
    const result = resolveBriefingReferences(
      "Review [[activity:github:pr:warden#9]]",
      briefingGather(),
    );

    assert.deepEqual(result.resolved, ["activity:github:pr:warden#9"]);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.segments, [
      { kind: "text", text: "Review " },
      {
        kind: "reference",
        reference: "activity:github:pr:warden#9",
        label: "Review requested on warden#9",
        href: "https://github.com/99Yash/warden/pull/9",
        source: "integration_activity",
      },
    ]);
  });

  test("keeps unknown placeholders as text and records them as unresolved", () => {
    const result = resolveBriefingReferences(
      "[[activity:github:pr:warden#999]]",
      briefingGather(),
    );

    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.unresolved, ["activity:github:pr:warden#999"]);
    assert.deepEqual(result.segments, [
      { kind: "text", text: "activity:github:pr:warden#999" },
    ]);
  });

  test("segments mixed prose with an email reference", () => {
    const result = resolveBriefingReferences(
      "On a quiet day, check [[email:thr_abc]]",
      briefingGather(),
    );

    assert.deepEqual(result.resolved, ["email:thr_abc"]);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.segments, [
      { kind: "text", text: "On a quiet day, check " },
      {
        kind: "reference",
        reference: "email:thr_abc",
        label: "Quarterly check-in",
        href: "https://mail.google.com/mail/u/0/#all/gmail-thread-abc",
        source: "email",
      },
    ]);
  });

  test("segments adjacent activity placeholders separately", () => {
    const result = resolveBriefingReferences("[[activity:a]] and [[activity:b]]", briefingGather());

    assert.deepEqual(result.resolved, ["activity:a", "activity:b"]);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.segments, [
      {
        kind: "reference",
        reference: "activity:a",
        label: "Deploy started",
        href: "https://deploy.example/a",
        source: "integration_activity",
      },
      { kind: "text", text: " and " },
      {
        kind: "reference",
        reference: "activity:b",
        label: "Deploy recovered",
        href: "https://deploy.example/b",
        source: "integration_activity",
      },
    ]);
  });
});

function briefingGather(): BriefingGather {
  return {
    email: {
      categories: {
        urgent: [
          {
            documentId: "thr_abc",
            threadId: "gmail-thread-abc",
            subject: "Quarterly check-in",
            sender: "Ada Lovelace",
            snippet: "Can you review the agenda?",
          },
        ],
      },
    },
    calendar: {
      events: [
        {
          eventId: "meeting-1",
          title: "Planning",
          start: "2026-06-02T10:00:00+05:30",
          end: "2026-06-02T10:30:00+05:30",
          attendees: ["ada@example.com"],
        },
      ],
    },
    integration_activity: {
      items: [
        {
          id: "github:pr:warden#9",
          provider: "github",
          source: "direct_api",
          activityCategory: "work",
          providerKind: "github.pr_review_requested",
          title: "Review requested on warden#9",
          occurredAt: "2026-06-02T03:00:00.000Z",
          url: "https://github.com/99Yash/warden/pull/9",
        },
        {
          id: "a",
          provider: "github",
          source: "direct_api",
          activityCategory: "deploy",
          providerKind: "deploy.started",
          title: "Deploy started",
          occurredAt: "2026-06-02T04:00:00.000Z",
          url: "https://deploy.example/a",
        },
        {
          id: "b",
          provider: "github",
          source: "direct_api",
          activityCategory: "deploy",
          providerKind: "deploy.recovered",
          title: "Deploy recovered",
          occurredAt: "2026-06-02T04:10:00.000Z",
          url: "https://deploy.example/b",
        },
      ],
    },
    weather: null,
    day_of_week: {
      dayName: "Tuesday",
      isWeekend: false,
    },
  };
}
