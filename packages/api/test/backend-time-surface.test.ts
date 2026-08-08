import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";

// The transitional `@alfred/api/backend` facade re-exports the time surface from
// `@alfred/assistant/time`. This test pins that door: the 54 scripts + the web
// Eden type still reach the same symbols through `@alfred/api/backend` until 6D
// rewires them, so the re-export at `backend.ts` must stay byte-identical for the
// whole time interface. Written to be green against today's backend and to stay
// green through the move — the byte-identical-surface regression guard.
import {
  addDays,
  DEFAULT_USER_TIMEZONE,
  firstValidTimezone,
  formatDay,
  inZone,
  isLocalDateKey,
  isValidTimezone,
  parseLocalDateKey,
  TIMEZONE_PREFERENCE_KEYS,
  weekdayIndex,
  type LocalDateKey,
  type LocalDayStyle,
  type LocalWallClock,
  type ZoneClock,
} from "@alfred/api/backend";

describe("@alfred/api/backend re-exports the @alfred/assistant/time surface", () => {
  test("every runtime export is present through the facade", () => {
    for (const [name, value] of [
      ["inZone", inZone],
      ["addDays", addDays],
      ["formatDay", formatDay],
      ["isLocalDateKey", isLocalDateKey],
      ["parseLocalDateKey", parseLocalDateKey],
      ["weekdayIndex", weekdayIndex],
      ["firstValidTimezone", firstValidTimezone],
      ["isValidTimezone", isValidTimezone],
    ] as const) {
      assert.equal(typeof value, "function", `${name} should be a function`);
    }
    assert.equal(typeof DEFAULT_USER_TIMEZONE, "string");
    assert.deepEqual(TIMEZONE_PREFERENCE_KEYS, ["timezone", "briefing.timezone"]);
  });

  test("the re-exported behavior still works through the facade", () => {
    // The four type exports are used in type position so `tsc` fails the build if
    // the facade drops any of them.
    const clock: ZoneClock = inZone(parseIanaTimezone("UTC"));
    const day: LocalDateKey = clock.day();
    const style: LocalDayStyle = "weekday";
    const wall: LocalWallClock = clock.clock();

    assert.equal(isLocalDateKey(day), true);
    assert.equal(isValidTimezone("UTC"), true);
    assert.equal(isValidTimezone("Not/AZone"), false);
    assert.notEqual(addDays(day, 1), day);
    assert.equal(typeof formatDay(day, style), "string");
    assert.equal(typeof wall.localTime, "string");
    assert.equal(weekdayIndex(day) >= 0, true);
    assert.equal(firstValidTimezone(["Not/AZone", "UTC"]), "UTC");
    assert.equal(parseLocalDateKey("2026-06-11"), "2026-06-11");
  });
});
