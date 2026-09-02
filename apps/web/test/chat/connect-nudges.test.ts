import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { syncedChatToolCallSchema } from "@alfred/sync";

import type { IntegrationStatus } from "../../src/lib/integrations/integrations";
import {
  presentConnectNudges,
  splitPersistedToolCalls,
} from "../../src/routes/-chat/connect-nudges";

/** Typed constructor: a misspelled status is a compile error, not a drift. */
function statuses(
  ...entries: ReadonlyArray<readonly [string, IntegrationStatus]>
): ReadonlyMap<string, IntegrationStatus> {
  return new Map(entries);
}

describe("splitPersistedToolCalls", () => {
  test("nudge entries leave the card list; everything else passes through", () => {
    const { cards, nudges } = splitPersistedToolCalls([
      {
        toolCallId: "t1",
        toolName: "calendar.list_events",
        status: "succeeded",
        segmentIndex: 0,
      },
      {
        toolCallId: "t2",
        toolName: "gmail.search",
        status: "failed",
        segmentIndex: 0,
        connectNudge: { integration: "gmail", action: "connect" },
      },
    ]);
    assert.deepEqual(
      cards.map((c) => c.toolCallId),
      ["t1"],
    );
    assert.deepEqual(nudges, [{ integration: "gmail", action: "connect" }]);
  });

  test("repeated bounces for one integration keep position but take the last offer", () => {
    const { cards, nudges } = splitPersistedToolCalls([
      {
        toolCallId: "a",
        toolName: "gmail.search",
        status: "failed",
        segmentIndex: 0,
        connectNudge: { integration: "gmail", action: "connect" },
      },
      {
        toolCallId: "b",
        toolName: "notion.search",
        status: "failed",
        segmentIndex: 1,
        connectNudge: { integration: "notion", action: "connect" },
      },
      {
        toolCallId: "c",
        toolName: "gmail.send_draft",
        status: "failed",
        segmentIndex: 2,
        connectNudge: { integration: "gmail", action: "reconnect" },
      },
    ]);
    // Same rule as the live stream state's map: gmail stays in first position
    // and its last offer wins, so a reload matches what the turn streamed.
    assert.deepEqual(nudges, [
      { integration: "gmail", action: "reconnect" },
      { integration: "notion", action: "connect" },
    ]);
    // Every bounced entry stays out of the drawable trail.
    assert.deepEqual(cards, []);
  });

  test("a persisted nudge the registry no longer knows drops; the cards and the other offers stay", () => {
    // The durable row is parsed by the sync schema before it reaches this
    // module. A foreign slug (here NUL-bearing, the ADR-0070 poison shape) must
    // not fail the whole message: the entry reads `null` and is neither a card
    // nor an offer (plan section 8 item 6).
    const persisted = [
      { toolCallId: "t1", toolName: "calendar.list_events", status: "succeeded", segmentIndex: 0 },
      {
        toolCallId: "t2",
        toolName: "github.request",
        status: "failed",
        segmentIndex: 1,
        connectNudge: { integration: "gith\u0000ub", action: "connect" },
      },
      {
        toolCallId: "t3",
        toolName: "gmail.search",
        status: "failed",
        segmentIndex: 2,
        connectNudge: { integration: "gmail", action: "connect" },
      },
    ];
    const parsed = persisted.map((row) => syncedChatToolCallSchema.parse(row));
    assert.equal(parsed[1]?.connectNudge, null);
    assert.deepEqual(parsed[2]?.connectNudge, { integration: "gmail", action: "connect" });

    const { cards, nudges } = splitPersistedToolCalls(parsed);
    assert.deepEqual(
      cards.map((c) => c.toolCallId),
      ["t1"],
    );
    assert.deepEqual(nudges, [{ integration: "gmail", action: "connect" }]);
  });
});

describe("presentConnectNudges", () => {
  test("no views while credential queries are loading", () => {
    assert.deepEqual(
      presentConnectNudges([{ integration: "gmail", action: "connect" }], undefined),
      [],
    );
  });

  test("an unconnected provider resolves to a view with copy and route param", () => {
    const [view] = presentConnectNudges(
      [{ integration: "gmail", action: "connect" }],
      statuses(["google_gmail", "available"]),
    );
    assert.ok(view);
    assert.equal(view.providerId, "google_gmail");
    assert.equal(view.name, "Gmail");
    assert.equal(view.line, "Gmail isn't connected.");
    assert.equal(view.cta, "Connect Gmail");
  });

  test("needs_reauth reads as a reconnect offer", () => {
    const [view] = presentConnectNudges(
      [{ integration: "github", action: "reconnect" }],
      statuses(["github", "available"]),
    );
    assert.ok(view);
    assert.equal(view.line, "GitHub needs to be reconnected.");
    assert.equal(view.cta, "Reconnect GitHub");
  });

  test("an already-connected provider is no longer offered", () => {
    assert.deepEqual(
      presentConnectNudges(
        [{ integration: "gmail", action: "connect" }],
        statuses(["google_gmail", "connected"]),
      ),
      [],
    );
  });

  test("a provider with no connect flow offers nothing it cannot honour", () => {
    assert.deepEqual(
      presentConnectNudges(
        [
          { integration: "slack", action: "connect" },
          { integration: "imessage", action: "connect" },
          { integration: "mcp", action: "connect" },
        ],
        statuses(),
      ),
      [],
    );
  });

  test("short Google aliases resolve through the catalog", () => {
    const [view] = presentConnectNudges(
      [{ integration: "calendar", action: "connect" }],
      statuses(["google_calendar", "available"]),
    );
    assert.ok(view);
    assert.equal(view.providerId, "google_calendar");
  });
});
