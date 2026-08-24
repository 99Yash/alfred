import assert from "node:assert/strict";
import { describe, test } from "node:test";

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

  test("repeated bounces for one integration dedupe to the first offer", () => {
    const { nudges } = splitPersistedToolCalls([
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
    assert.deepEqual(nudges, [
      { integration: "gmail", action: "connect" },
      { integration: "notion", action: "connect" },
    ]);
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
