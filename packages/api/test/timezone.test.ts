import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addLocalDays,
  dayBoundsInTimezone,
  formatInstantInTimezone,
  formatLocalDayLong,
  formatLocalDayShort,
  formatLocalWeekday,
  formatUtcOffset,
  localDateInTimezone,
  localHourInTimezone,
  localStartOfDay,
  localWallClockInTimezone,
  offsetMsAt,
} from "../src/modules/timezone";

describe("formatInstantInTimezone", () => {
  // The #284 evidence instant: a ClickUp notification received at 21:40 UTC,
  // which is 03:10 the next morning in India — the "late-night request" the
  // briefing must be able to phrase by local time.
  const overnight = new Date("2026-06-26T21:40:00.000Z");

  test("renders wall-clock in the user's timezone, rolling the local date when needed", () => {
    const asia = formatInstantInTimezone(overnight, "Asia/Kolkata");
    assert.ok(asia?.includes("3:10 AM"), `expected 3:10 AM, got: ${asia}`);
    assert.ok(asia?.includes("Jun 27"), `expected Jun 27 (date rolled), got: ${asia}`);
  });

  test("reflects a different timezone's offset", () => {
    const ny = formatInstantInTimezone(overnight, "America/New_York");
    assert.ok(ny?.includes("5:40 PM"), `expected 5:40 PM (EDT), got: ${ny}`);
    assert.ok(ny?.includes("Jun 26"), `expected Jun 26, got: ${ny}`);
  });

  test("returns null for a null instant so a nullable authoredAt passes through", () => {
    assert.equal(formatInstantInTimezone(null, "Asia/Kolkata"), null);
  });
});

describe("localDateInTimezone", () => {
  // The instant every "which day is it" bug is born on: late evening UTC, which
  // is already tomorrow east of UTC and still yesterday far enough west.
  const evening = new Date("2026-06-10T19:30:00.000Z");

  test("is the local calendar day, not the UTC one", () => {
    assert.equal(localDateInTimezone("UTC", evening), "2026-06-10");
    assert.equal(localDateInTimezone("Asia/Kolkata", evening), "2026-06-11");
    assert.equal(localDateInTimezone("America/Los_Angeles", evening), "2026-06-10");
  });

  test("crosses back a day west of UTC just after UTC midnight", () => {
    const justAfterMidnight = new Date("2026-06-11T00:30:00.000Z");
    assert.equal(localDateInTimezone("UTC", justAfterMidnight), "2026-06-11");
    assert.equal(localDateInTimezone("America/Los_Angeles", justAfterMidnight), "2026-06-10");
  });
});

describe("localHourInTimezone", () => {
  test("reads the local wall-clock hour", () => {
    const instant = new Date("2026-06-10T19:30:00.000Z");
    assert.equal(localHourInTimezone("UTC", instant), 19);
    assert.equal(localHourInTimezone("Asia/Kolkata", instant), 1);
    assert.equal(localHourInTimezone("America/New_York", instant), 15);
  });

  test("normalizes a midnight reported as hour 24", () => {
    assert.equal(localHourInTimezone("UTC", new Date("2026-06-10T00:15:00.000Z")), 0);
  });
});

describe("offsetMsAt / formatUtcOffset", () => {
  test("reads a whole-hour, half-hour, and zero offset", () => {
    const summer = new Date("2026-07-14T12:00:00.000Z");
    assert.equal(offsetMsAt(summer, "UTC"), 0);
    assert.equal(offsetMsAt(summer, "Asia/Kolkata"), 5.5 * 3_600_000);
    assert.equal(offsetMsAt(summer, "America/New_York"), -4 * 3_600_000);
  });

  test("follows the zone across its own DST transition", () => {
    const winter = new Date("2026-01-14T12:00:00.000Z");
    assert.equal(formatUtcOffset(winter, "America/New_York"), "-05:00");
    assert.equal(
      formatUtcOffset(new Date("2026-07-14T12:00:00.000Z"), "America/New_York"),
      "-04:00",
    );
  });

  test("renders a bare-GMT zone as +00:00 rather than an empty string", () => {
    assert.equal(formatUtcOffset(new Date("2026-07-14T12:00:00.000Z"), "UTC"), "+00:00");
  });
});

describe("dayBoundsInTimezone", () => {
  test("brackets the local day the instant falls in", () => {
    // 19:30 UTC is 01:00 on Jun 11 in Kolkata, so the day being bracketed is
    // Jun 11 local = [Jun 10 18:30Z, Jun 11 18:30Z).
    const { start, end } = dayBoundsInTimezone(
      new Date("2026-06-10T19:30:00.000Z"),
      "Asia/Kolkata",
    );
    assert.equal(start.toISOString(), "2026-06-10T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-06-11T18:30:00.000Z");
  });

  test("yields a 23-hour window on a spring-forward day", () => {
    // US DST starts 2026-03-08. The local day is one hour short, and each bound
    // must converge on its OWN offset for that to come out right.
    const { start, end } = dayBoundsInTimezone(
      new Date("2026-03-08T18:00:00.000Z"),
      "America/New_York",
    );
    assert.equal(end.getTime() - start.getTime(), 23 * 3_600_000);
  });

  test("yields a 25-hour window on a fall-back day", () => {
    const { start, end } = dayBoundsInTimezone(
      new Date("2026-11-01T18:00:00.000Z"),
      "America/New_York",
    );
    assert.equal(end.getTime() - start.getTime(), 25 * 3_600_000);
  });
});

describe("addLocalDays / localStartOfDay", () => {
  test("adds whole calendar days, crossing a month and a year", () => {
    assert.equal(addLocalDays("2026-06-30", 1), "2026-07-01");
    assert.equal(addLocalDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addLocalDays("2026-06-10", 0), "2026-06-10");
  });

  test("day arithmetic is unaffected by a DST transition in between", () => {
    // +1 day across spring-forward is still the next calendar day, even though
    // the two midnights are 23 hours apart.
    assert.equal(addLocalDays("2026-03-07", 1), "2026-03-08");
    const start = localStartOfDay("2026-03-08", "America/New_York");
    assert.equal(start.toISOString(), "2026-03-08T05:00:00.000Z");
  });
});

describe("local date key rendering", () => {
  test("renders a key without re-projecting it through a zone", () => {
    assert.equal(formatLocalDayShort("2026-06-11"), "Jun 11");
    assert.equal(formatLocalDayLong("2026-06-10"), "Wednesday, 10 June 2026");
    assert.equal(formatLocalWeekday("2026-06-13"), "Saturday");
  });
});

describe("localWallClockInTimezone", () => {
  test("reports the date, time, weekday, and offset the user is reading", () => {
    assert.deepEqual(
      localWallClockInTimezone(new Date("2026-07-14T16:20:11.000Z"), "Asia/Kolkata"),
      {
        localDate: "2026-07-14",
        localTime: "21:50:11",
        weekday: "Tuesday",
        utcOffset: "+05:30",
      },
    );
  });

  test("rolls the local date backwards west of UTC just after UTC midnight", () => {
    assert.deepEqual(
      localWallClockInTimezone(new Date("2026-07-15T00:30:00.000Z"), "America/Los_Angeles"),
      {
        localDate: "2026-07-14",
        localTime: "17:30:00",
        weekday: "Tuesday",
        utcOffset: "-07:00",
      },
    );
  });

  test("reports midnight as 00, not 24", () => {
    assert.equal(
      localWallClockInTimezone(new Date("2026-07-14T00:00:00.000Z"), "UTC").localTime,
      "00:00:00",
    );
  });
});
