import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatDateGrounding,
  formatRuntimeTimeGrounding,
  resolveRuntimeGroundingAnchor,
} from "@alfred/assistant/execution/grounding";

describe("formatDateGrounding", () => {
  test("keeps the cached system grounding date-only", () => {
    assert.equal(
      formatDateGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "Tuesday, 14 July 2026 (2026-07-14), timezone Asia/Calcutta",
    );
  });

  test("the runtime line is a complete 'now': weekday, date, local + UTC instant", () => {
    // The only "now" in chat. It needs the weekday so "next Tuesday" resolves.
    assert.equal(
      formatRuntimeTimeGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "<runtime_context>Current date and time: Tuesday, 14 July 2026, 08:20:11 (2026-07-14T08:20:11 in Asia/Calcutta; 2026-07-14T02:50:11.451Z UTC).</runtime_context>",
    );
  });
});

describe("resolveRuntimeGroundingAnchor", () => {
  const anchor = new Date("2026-07-14T15:00:00.000Z");

  test("first turn (no previous anchor) anchors to now", () => {
    const now = new Date("2026-07-14T15:00:00.000Z");
    assert.equal(
      resolveRuntimeGroundingAnchor(undefined, "Asia/Calcutta", now).getTime(),
      now.getTime(),
    );
  });

  test("a contiguous tool loop reuses the anchor so the tool-result tail stays cacheable", () => {
    const nextLoopTurn = new Date(anchor.getTime() + 8_000);
    assert.equal(
      resolveRuntimeGroundingAnchor(anchor, "Asia/Calcutta", nextLoopTurn).getTime(),
      anchor.getTime(),
    );
    assert.equal(
      formatRuntimeTimeGrounding(
        "Asia/Calcutta",
        resolveRuntimeGroundingAnchor(anchor, "Asia/Calcutta", nextLoopTurn),
      ),
      formatRuntimeTimeGrounding("Asia/Calcutta", anchor),
    );
  });

  test("a long uninterrupted tool loop still reuses the anchor", () => {
    const tenMinutesLater = new Date(anchor.getTime() + 10 * 60_000);
    assert.equal(
      resolveRuntimeGroundingAnchor(anchor, "Asia/Calcutta", tenMinutesLater).getTime(),
      anchor.getTime(),
    );
  });

  test("a short park keeps the anchor, so the cached tail behind the line survives", () => {
    // A new stamp on each short park would void the prompt cache after this line.
    const wokeAt = new Date(anchor.getTime() + 9_000);
    assert.equal(
      formatRuntimeTimeGrounding(
        "Asia/Calcutta",
        resolveRuntimeGroundingAnchor(anchor, "Asia/Calcutta", wokeAt),
      ),
      formatRuntimeTimeGrounding("Asia/Calcutta", anchor),
    );
  });

  test("a park past the cache grace arrives cleared and re-anchors to wake time", () => {
    // `foldResumedPark` clears the anchor once the park outlives the cache.
    const wokeAt = new Date(anchor.getTime() + 6 * 60_000);
    const resolved = resolveRuntimeGroundingAnchor(undefined, "UTC", wokeAt);
    assert.equal(resolved.getTime(), wokeAt.getTime());
    assert.notEqual(
      formatRuntimeTimeGrounding("UTC", resolved),
      formatRuntimeTimeGrounding("UTC", anchor),
    );
  });

  test("an overnight park re-anchors so the resumed runtime line reads the next DAY", () => {
    // Three minutes is inside the cache grace, so only the local-day rule re-anchors.
    const startedAt = new Date("2026-07-15T03:58:00.000Z");
    const wokeAt = new Date("2026-07-15T04:01:00.000Z");
    const resolved = resolveRuntimeGroundingAnchor(startedAt, "America/New_York", wokeAt);
    assert.equal(resolved.getTime(), wokeAt.getTime());
    const line = formatRuntimeTimeGrounding("America/New_York", resolved);
    assert.match(line, /Wednesday, 15 July 2026/); // the day advanced, not just the clock
    assert.match(line, /2026-07-15T00:01:00 in America\/New_York/);
    assert.doesNotMatch(line, /Tuesday|14 July/);
  });

  test("the same three minutes inside one day keeps the anchor", () => {
    // Control: without it, a resolver that always re-anchors would pass the test above.
    const startedAt = new Date("2026-07-15T15:58:00.000Z");
    const wokeAt = new Date("2026-07-15T16:01:00.000Z");
    assert.equal(
      resolveRuntimeGroundingAnchor(startedAt, "America/New_York", wokeAt).getTime(),
      startedAt.getTime(),
    );
  });

  test("a previous anchor ahead of now (clock skew / bad state) re-anchors to now", () => {
    const now = new Date("2026-07-14T15:00:00.000Z");
    const future = new Date(now.getTime() + 60_000);
    assert.equal(
      resolveRuntimeGroundingAnchor(future, "Asia/Calcutta", now).getTime(),
      now.getTime(),
    );
  });
});
