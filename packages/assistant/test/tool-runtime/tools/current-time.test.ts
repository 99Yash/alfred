import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseIanaTimezone } from "@alfred/contracts";

import { currentTimeSnapshot } from "../../../src/tool-runtime/internal/tools/system";

const UTC = parseIanaTimezone("UTC");
const KOLKATA = parseIanaTimezone("Asia/Kolkata");
const LOS_ANGELES = parseIanaTimezone("America/Los_Angeles");
const NEW_YORK = parseIanaTimezone("America/New_York");

describe("currentTimeSnapshot", () => {
  const instant = new Date("2026-07-14T16:20:11.000Z");

  test("returns exactly the six documented fields", () => {
    assert.deepEqual(Object.keys(currentTimeSnapshot(UTC, instant)).sort(), [
      "isoTime",
      "localDate",
      "localTime",
      "timezone",
      "utcOffset",
      "weekday",
    ]);
  });

  test("isoTime is the exact instant, independent of timezone", () => {
    assert.equal(currentTimeSnapshot(UTC, instant).isoTime, "2026-07-14T16:20:11.000Z");
    assert.equal(currentTimeSnapshot(KOLKATA, instant).isoTime, "2026-07-14T16:20:11.000Z");
    assert.equal(currentTimeSnapshot(LOS_ANGELES, instant).isoTime, "2026-07-14T16:20:11.000Z");
  });

  test("grounds local date, time, weekday, and offset in UTC", () => {
    assert.deepEqual(currentTimeSnapshot(UTC, instant), {
      isoTime: "2026-07-14T16:20:11.000Z",
      localDate: "2026-07-14",
      localTime: "16:20:11",
      weekday: "Tuesday",
      timezone: UTC,
      utcOffset: "+00:00",
    });
  });

  test("applies a half-hour positive offset (Asia/Kolkata, +05:30)", () => {
    assert.deepEqual(currentTimeSnapshot(KOLKATA, instant), {
      isoTime: "2026-07-14T16:20:11.000Z",
      localDate: "2026-07-14",
      localTime: "21:50:11",
      weekday: "Tuesday",
      timezone: KOLKATA,
      utcOffset: "+05:30",
    });
  });

  test("applies a negative offset (America/Los_Angeles, PDT -07:00)", () => {
    assert.deepEqual(currentTimeSnapshot(LOS_ANGELES, instant), {
      isoTime: "2026-07-14T16:20:11.000Z",
      localDate: "2026-07-14",
      localTime: "09:20:11",
      weekday: "Tuesday",
      timezone: LOS_ANGELES,
      utcOffset: "-07:00",
    });
  });

  test("respects daylight-saving: New York is -04:00 in summer, -05:00 in winter", () => {
    assert.equal(currentTimeSnapshot(NEW_YORK, instant).utcOffset, "-04:00");
    assert.equal(
      currentTimeSnapshot(NEW_YORK, new Date("2026-01-14T16:20:11.000Z")).utcOffset,
      "-05:00",
    );
  });

  test("rolls the local date back a day west of UTC just after UTC midnight", () => {
    const justAfterUtcMidnight = new Date("2026-07-15T02:00:00.000Z");
    const la = currentTimeSnapshot(LOS_ANGELES, justAfterUtcMidnight);
    assert.equal(la.localDate, "2026-07-14"); // 19:00 PDT, still the 14th
    assert.equal(la.localTime, "19:00:00");
  });
});
