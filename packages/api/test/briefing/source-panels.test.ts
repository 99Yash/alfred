import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  briefingReference,
  type BriefingGather,
  type BriefingSegment,
  type IntegrationActivityItem,
} from "@alfred/contracts";

import {
  buildBriefingSourcePanels,
  renderBriefingEmailHtml,
} from "../../src/modules/briefing/references";

/**
 * Characterization of the two server-side halves of `briefing/references.ts`
 * (campaign arch-20260727 item 06). `references.test.ts` covers only the pure
 * resolver that relocated to `@alfred/contracts`; the panel builder and the
 * email renderer had no test at all, and both sit directly on the
 * gather → compose seam that item 06 rewrites.
 *
 * These pin today's behaviour, including the bits that look accidental (the
 * `start - end` subtitle with no formatting, the ordering that is only stable
 * for referenced-vs-not). If a later change means to alter one, the assertion
 * should be updated deliberately, not deleted.
 */

function activityItem(overrides: Partial<IntegrationActivityItem> = {}): IntegrationActivityItem {
  return {
    id: "whe_1",
    provider: "github",
    source: "direct_api",
    activityCategory: "work",
    providerKind: "github.pull_request.closed",
    title: "PR #12 merged in o/r",
    status: "resolved",
    severity: "info",
    occurredAt: "2026-06-27T09:00:00.000Z",
    url: "https://github.com/o/r/pull/12",
    relatedRepo: "o/r",
    ...overrides,
  };
}

function gather(overrides: Partial<BriefingGather> = {}): BriefingGather {
  return {
    email: { categories: {} },
    calendar: null,
    integration_activity: { items: [] },
    weather: null,
    day_of_week: { dayName: "Saturday", isWeekend: true },
    ...overrides,
  };
}

describe("buildBriefingSourcePanels", () => {
  test("an empty gather still yields the always-present day panel and drops the empty ones", () => {
    const panels = buildBriefingSourcePanels(gather());

    // email + integration_activity are pushed unconditionally but filtered out
    // when empty; day_of_week is deterministic so it always has one item.
    assert.deepEqual(
      panels.map((p) => p.source),
      ["day_of_week"],
    );
    assert.equal(panels[0]?.items.length, 1);
    assert.equal(panels[0]?.items[0]?.title, "Saturday");
    assert.deepEqual(panels[0]?.items[0]?.metadata, { weekend: "true" });
  });

  test("panels come back in source order with their fixed labels", () => {
    const panels = buildBriefingSourcePanels(
      gather({
        email: {
          categories: {
            action_needed: [
              {
                documentId: "doc_1",
                threadId: "thr_1",
                subject: "Can you review this?",
                sender: "Sakshi",
                snippet: "before EOD",
              },
            ],
          },
        },
        calendar: {
          events: [
            {
              eventId: "evt_1",
              title: "Standup",
              start: "2026-06-27T09:30:00Z",
              end: "2026-06-27T09:45:00Z",
              attendees: ["a@example.com", "b@example.com"],
              location: "Meet",
            },
          ],
        },
        integration_activity: { items: [activityItem()] },
        weather: {
          current: { temperatureC: 28.4, apparentTemperatureC: 31.6, description: "Clear" },
          forecast: { highC: 33.2, lowC: 24.1, precipitationMm: 0, description: "Sunny" },
        },
      }),
    );

    assert.deepEqual(
      panels.map((p) => [p.source, p.label]),
      [
        ["email", "Email"],
        ["calendar", "Calendar"],
        ["integration_activity", "Activity"],
        ["weather", "Weather"],
        ["day_of_week", "Day"],
      ],
    );
  });

  test("an email item carries its gmail href, reference and category metadata", () => {
    const [emailPanel] = buildBriefingSourcePanels(
      gather({
        email: {
          categories: {
            payment: [
              {
                documentId: "doc_pay",
                threadId: "thr_pay",
                subject: "Payment failed",
                sender: "Railway",
                snippet: "update your card",
              },
            ],
          },
        },
      }),
    );

    const item = emailPanel?.items[0];
    assert.equal(item?.id, "doc_pay");
    assert.equal(item?.title, "Payment failed");
    assert.equal(item?.subtitle, "Railway");
    assert.equal(item?.href, "https://mail.google.com/mail/u/0/#all/thr_pay");
    assert.equal(item?.reference, briefingReference("email", "doc_pay"));
    assert.deepEqual(item?.metadata, { category: "payment", snippet: "update your card" });
  });

  test("a thread-less email item gets no href but keeps its reference", () => {
    const [emailPanel] = buildBriefingSourcePanels(
      gather({
        email: {
          categories: {
            urgent: [
              {
                documentId: "doc_nothread",
                threadId: "",
                subject: "No thread",
                sender: "Someone",
                snippet: "",
              },
            ],
          },
        },
      }),
    );

    assert.equal(emailPanel?.items[0]?.href, undefined);
    assert.equal(emailPanel?.items[0]?.reference, briefingReference("email", "doc_nothread"));
    // An empty snippet is dropped by compactMetadata rather than kept as "".
    assert.deepEqual(emailPanel?.items[0]?.metadata, { category: "urgent" });
  });

  test("referenced items sort ahead of unreferenced ones and are flagged in metadata", () => {
    const emailFor = (id: string) => ({
      documentId: id,
      threadId: `thr_${id}`,
      subject: id,
      sender: "Someone",
      snippet: "s",
    });
    const [emailPanel] = buildBriefingSourcePanels(
      gather({
        email: {
          categories: { action_needed: [emailFor("a"), emailFor("b"), emailFor("c")] },
        },
      }),
      [briefingReference("email", "c")],
    );

    assert.deepEqual(
      emailPanel?.items.map((i) => i.id),
      ["c", "a", "b"],
    );
    assert.equal(emailPanel?.items[0]?.metadata?.referenced, "true");
    assert.equal(emailPanel?.items[1]?.metadata?.referenced, undefined);
  });

  test("calendar and activity subtitles are the current unformatted joins", () => {
    const panels = buildBriefingSourcePanels(
      gather({
        calendar: {
          events: [
            {
              eventId: "evt_1",
              title: "Standup",
              start: "2026-06-27T09:30:00Z",
              end: "2026-06-27T09:45:00Z",
              attendees: ["a@example.com"],
            },
          ],
        },
        integration_activity: {
          items: [
            activityItem({ rollup: { eventCount: 3, attemptCount: 2, durationMinutes: 11 } }),
          ],
        },
      }),
    );

    const calendar = panels.find((p) => p.source === "calendar");
    assert.equal(calendar?.items[0]?.subtitle, "2026-06-27T09:30:00Z - 2026-06-27T09:45:00Z");
    assert.deepEqual(calendar?.items[0]?.metadata, { attendees: "1" });
    assert.equal(calendar?.items[0]?.reference, briefingReference("meeting", "evt_1"));

    const activity = panels.find((p) => p.source === "integration_activity");
    assert.equal(activity?.items[0]?.subtitle, "github · o/r · github.pull request.closed");
    assert.deepEqual(activity?.items[0]?.metadata, {
      category: "work",
      occurredAt: "2026-06-27T09:00:00.000Z",
      events: "3",
      attempts: "2",
      durationMinutes: "11",
    });
  });

  test("weather rounds to whole degrees in the subtitle", () => {
    const panels = buildBriefingSourcePanels(
      gather({
        weather: {
          current: { temperatureC: 28.4, apparentTemperatureC: 31.6, description: "Clear" },
          forecast: { highC: 33.2, lowC: 24.1, precipitationMm: 0, description: "Sunny" },
        },
      }),
    );

    const weather = panels.find((p) => p.source === "weather");
    assert.equal(weather?.items[0]?.title, "Clear");
    assert.equal(weather?.items[0]?.subtitle, "28C now, 33C high");
    // compactMetadata filters on the stringified value, so a 0mm forecast still
    // renders a "0" entry rather than being dropped. Pinned as-is.
    assert.deepEqual(weather?.items[0]?.metadata, {
      feelsLikeC: "32",
      precipitationMm: "0",
      forecast: "Sunny",
    });
  });

  test("each panel is capped at 50 items", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      documentId: `doc_${i}`,
      threadId: `thr_${i}`,
      subject: `s${i}`,
      sender: "Someone",
      snippet: "s",
    }));
    const [emailPanel] = buildBriefingSourcePanels(
      gather({ email: { categories: { action_needed: items } } }),
    );

    assert.equal(emailPanel?.items.length, 50);
  });
});

describe("renderBriefingEmailHtml", () => {
  const segments: BriefingSegment[] = [
    { kind: "text", text: "Two things.\nFirst, " },
    {
      kind: "reference",
      label: "Payment failed",
      href: "https://mail.google.com/x",
      reference: briefingReference("email", "doc_pay"),
      referenceKind: "email",
      source: "email",
    },
    { kind: "text", text: " needs a card update." },
  ];

  test("text output concatenates segments and parenthesizes reference hrefs", () => {
    const { text } = renderBriefingEmailHtml({ segments });

    assert.equal(
      text,
      "Two things.\nFirst, Payment failed (https://mail.google.com/x) needs a card update.",
    );
  });

  test("html wraps one paragraph, turns newlines into breaks and links references", () => {
    const { html } = renderBriefingEmailHtml({ segments });

    // The wrapper style itself contains quotes ("Segoe UI"), so match loosely.
    assert.ok(html.startsWith("<div style="));
    assert.match(html, /\n {2}<p style=/);
    assert.match(html, /Two things\.<br \/>First, /);
    assert.match(
      html,
      /<a href="https:\/\/mail\.google\.com\/x" style="[^"]+">Payment failed<\/a>/,
    );
    assert.ok(html.trimEnd().endsWith("</div>"));
  });

  test("a reference without an href renders as a plain span", () => {
    const { html, text } = renderBriefingEmailHtml({
      segments: [
        {
          kind: "reference",
          label: "Standup",
          reference: briefingReference("meeting", "evt_1"),
          referenceKind: "meeting",
          source: "calendar",
        },
      ],
    });

    assert.match(html, /<span>Standup<\/span>/);
    assert.equal(text, "Standup");
  });

  test("text and label content is html-escaped", () => {
    const { html } = renderBriefingEmailHtml({
      segments: [
        { kind: "text", text: `<script>alert("x" & 'y')</script>` },
        {
          kind: "reference",
          label: "<b>bold</b>",
          href: "https://x/?a=1&b=2",
          reference: briefingReference("email", "doc_1"),
          referenceKind: "email",
          source: "email",
        },
      ],
    });

    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot; &amp; &#39;y&#39;\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(html, /href="https:\/\/x\/\?a=1&amp;b=2"/);
  });

  test("a full-briefing url is appended to both renderings", () => {
    const { html, text } = renderBriefingEmailHtml({
      segments: [{ kind: "text", text: "Quiet day." }],
      fullBriefingUrl: "https://alfred.test/briefings/b_1",
    });

    assert.equal(text, "Quiet day.\n\nView full briefing: https://alfred.test/briefings/b_1");
    assert.match(
      html,
      /<a href="https:\/\/alfred\.test\/briefings\/b_1"[^>]*>View full briefing<\/a>/,
    );
  });
});
