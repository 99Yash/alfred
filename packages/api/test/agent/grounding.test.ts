import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatDateGrounding,
  formatRuntimeTimeGrounding,
  resolveRuntimeGroundingAnchor,
} from "../../src/modules/agent/grounding";

describe("formatDateGrounding", () => {
  test("keeps the cached system grounding date-only", () => {
    assert.equal(
      formatDateGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "Tuesday, 14 July 2026 (2026-07-14), timezone Asia/Calcutta",
    );
  });

  test("the runtime line is a complete 'now': weekday, date, local + UTC instant", () => {
    // Chat's single source of "now" — it must carry everything the old separate
    // system date line did (weekday + human date, for "next Tuesday") plus the
    // exact time, so nothing else has to state the date.
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
    assert.equal(resolveRuntimeGroundingAnchor(undefined, now).getTime(), now.getTime());
  });

  test("a contiguous tool loop reuses the anchor so the tool-result tail stays cacheable", () => {
    // A few seconds later — a normal next tool-loop turn — keeps the same anchor.
    const nextLoopTurn = new Date(anchor.getTime() + 8_000);
    assert.equal(resolveRuntimeGroundingAnchor(anchor, nextLoopTurn).getTime(), anchor.getTime());
    // Same instant on resume yields a byte-identical runtime line.
    assert.equal(
      formatRuntimeTimeGrounding(
        "Asia/Calcutta",
        resolveRuntimeGroundingAnchor(anchor, nextLoopTurn),
      ),
      formatRuntimeTimeGrounding("Asia/Calcutta", anchor),
    );
  });

  test("a long uninterrupted tool loop still reuses the anchor", () => {
    const tenMinutesLater = new Date(anchor.getTime() + 10 * 60_000);
    assert.equal(
      resolveRuntimeGroundingAnchor(anchor, tenMinutesLater).getTime(),
      anchor.getTime(),
    );
  });

  test("resumed-run freshness: a cleared park anchor re-anchors to wake time", () => {
    const wokeAt = new Date(anchor.getTime() + 1);
    const resolved = resolveRuntimeGroundingAnchor(undefined, wokeAt);
    assert.equal(resolved.getTime(), wokeAt.getTime());
    assert.notEqual(
      formatRuntimeTimeGrounding("UTC", resolved),
      formatRuntimeTimeGrounding("UTC", anchor),
    );
  });

  test("an overnight park re-anchors so the resumed runtime line reads the next DAY", () => {
    // Finding 1's counterexample: a run started at 23:58 in New York on Tue 14
    // July (EDT, -04:00) and approved at 00:01 on Wed 15 July. Because "now" is
    // the single re-anchorable line — the date is no longer separately pinned to
    // the start instant — the resumed line reads the wake-time DAY, not just its
    // time. There is no second date line left to contradict it.
    // Deliberately only three minutes: elapsed-time heuristics used to miss this
    // exact short-park counterexample. The park seam has cleared `previous`.
    const wokeAt = new Date("2026-07-15T04:01:00.000Z");
    const resolved = resolveRuntimeGroundingAnchor(undefined, wokeAt);
    assert.equal(resolved.getTime(), wokeAt.getTime());
    const line = formatRuntimeTimeGrounding("America/New_York", resolved);
    assert.match(line, /Wednesday, 15 July 2026/); // the day advanced, not just the clock
    assert.match(line, /2026-07-15T00:01:00 in America\/New_York/);
    // The pre-park start instant's day (Tuesday 14 July) is gone from the line.
    assert.doesNotMatch(line, /Tuesday|14 July/);
  });

  test("a previous anchor ahead of now (clock skew / bad state) re-anchors to now", () => {
    const now = new Date("2026-07-14T15:00:00.000Z");
    const future = new Date(now.getTime() + 60_000);
    assert.equal(resolveRuntimeGroundingAnchor(future, now).getTime(), now.getTime());
  });
});
