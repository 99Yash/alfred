import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";
import {
  addDays,
  formatDay,
  inZone,
  isLocalDateKey,
  parseLocalDateKey,
  weekdayIndex,
} from "@alfred/assistant/time";

// The two parsers, aliased for brevity — every zone and every day key in these
// tests goes through them, which is the point: outside this module a value has
// to be parsed into its type before it can be used as one.
const tz = parseIanaTimezone;
const day = parseLocalDateKey;

// The zones these tests keep returning to: UTC, a half-hour offset east, and a
// DST-observing zone west.
const utc = inZone(tz("UTC"));
const kolkata = inZone(tz("Asia/Kolkata"));
const newYork = inZone(tz("America/New_York"));

describe("parseLocalDateKey", () => {
  test("accepts a real calendar day", () => {
    assert.equal(parseLocalDateKey("2026-06-11"), "2026-06-11");
    assert.equal(parseLocalDateKey("2024-02-29"), "2024-02-29");
  });

  test("rejects a truncated key instead of silently completing it", () => {
    // The old `dateParts` read this as [2026, 0, 1] — so `addDays("2026", 1)`
    // returned "2026-01-02" and no caller ever learned it had been guessing.
    assert.throws(() => parseLocalDateKey("2026"), /not a local date key/);
    assert.throws(() => parseLocalDateKey("2026-06"), /not a local date key/);
  });

  test("rejects a wrong shape and a non-existent day", () => {
    assert.throws(() => parseLocalDateKey("11/06/2026"), /not a local date key/);
    assert.throws(() => parseLocalDateKey("2026-6-1"), /not a local date key/);
    // `Date.UTC` rolls these over in silence; the round-trip check catches them.
    assert.throws(() => parseLocalDateKey("2026-02-30"), /not a real calendar day/);
    assert.throws(() => parseLocalDateKey("2026-13-01"), /not a real calendar day/);
    assert.throws(() => parseLocalDateKey("2025-02-29"), /not a real calendar day/);
  });

  test("isLocalDateKey answers the same question without throwing", () => {
    assert.equal(isLocalDateKey("2026-06-11"), true);
    assert.equal(isLocalDateKey("2026-02-30"), false);
    assert.equal(isLocalDateKey(20260611), false);
    assert.equal(isLocalDateKey(null), false);
  });
});

describe("inZone", () => {
  test("returns the same clock for a zone, so calling it inline is free", () => {
    assert.equal(inZone(tz("Asia/Kolkata")), inZone(tz("Asia/Kolkata")));
    assert.notEqual(inZone(tz("Asia/Kolkata")), inZone(tz("UTC")));
  });

  test("carries its zone, so a clock can travel where a zone did", () => {
    assert.equal(inZone(tz("Asia/Kolkata")).timezone, "Asia/Kolkata");
  });
});

describe("clock.day", () => {
  // The instant every "which day is it" bug is born on: late evening UTC, which
  // is already tomorrow east of UTC and still yesterday far enough west.
  const evening = new Date("2026-06-10T19:30:00.000Z");

  test("is the local calendar day, not the UTC one", () => {
    assert.equal(utc.day(evening), "2026-06-10");
    assert.equal(kolkata.day(evening), "2026-06-11");
    assert.equal(inZone(tz("America/Los_Angeles")).day(evening), "2026-06-10");
  });

  test("crosses back a day west of UTC just after UTC midnight", () => {
    const justAfterMidnight = new Date("2026-06-11T00:30:00.000Z");
    assert.equal(utc.day(justAfterMidnight), "2026-06-11");
    assert.equal(inZone(tz("America/Los_Angeles")).day(justAfterMidnight), "2026-06-10");
  });

  test("mints a key the parser accepts, in a far-eastern zone too", () => {
    // The mint re-parses its own output, so a locale that stopped producing
    // YYYY-MM-DD would fail loudly here rather than poison every day key.
    assert.equal(isLocalDateKey(inZone(tz("Pacific/Kiritimati")).day()), true);
  });
});

describe("clock.hour", () => {
  test("reads the local wall-clock hour", () => {
    const instant = new Date("2026-06-10T19:30:00.000Z");
    assert.equal(utc.hour(instant), 19);
    assert.equal(kolkata.hour(instant), 1);
    assert.equal(newYork.hour(instant), 15);
  });

  test("normalizes a midnight reported as hour 24", () => {
    assert.equal(utc.hour(new Date("2026-06-10T00:15:00.000Z")), 0);
  });
});

describe("clock.offsetMs", () => {
  test("reads a whole-hour, half-hour, and zero offset", () => {
    const summer = new Date("2026-07-14T12:00:00.000Z");
    assert.equal(utc.offsetMs(summer), 0);
    assert.equal(kolkata.offsetMs(summer), 5.5 * 3_600_000);
    assert.equal(newYork.offsetMs(summer), -4 * 3_600_000);
  });

  test("follows the zone across its own DST transition", () => {
    assert.equal(newYork.offsetMs(new Date("2026-01-14T12:00:00.000Z")), -5 * 3_600_000);
    assert.equal(newYork.offsetMs(new Date("2026-07-14T12:00:00.000Z")), -4 * 3_600_000);
  });

  test("reads a bare-GMT zone as 0 rather than failing the parse", () => {
    // `longOffset` emits a bare "GMT" for UTC, with no sign group at all.
    assert.equal(utc.offsetMs(new Date("2026-07-14T12:00:00.000Z")), 0);
  });
});

describe("clock.dayBounds", () => {
  test("brackets the local day the instant falls in", () => {
    // 19:30 UTC is 01:00 on Jun 11 in Kolkata, so the day being bracketed is
    // Jun 11 local = [Jun 10 18:30Z, Jun 11 18:30Z).
    const { start, end } = kolkata.dayBounds(new Date("2026-06-10T19:30:00.000Z"));
    assert.equal(start.toISOString(), "2026-06-10T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-06-11T18:30:00.000Z");
  });

  test("yields a 23-hour window on a spring-forward day", () => {
    // US DST starts 2026-03-08. The local day is one hour short, and each bound
    // must converge on its OWN offset for that to come out right.
    const { start, end } = newYork.dayBounds(new Date("2026-03-08T18:00:00.000Z"));
    assert.equal(end.getTime() - start.getTime(), 23 * 3_600_000);
  });

  test("yields a 25-hour window on a fall-back day", () => {
    const { start, end } = newYork.dayBounds(new Date("2026-11-01T18:00:00.000Z"));
    assert.equal(end.getTime() - start.getTime(), 25 * 3_600_000);
  });

  test("regression: derives tomorrow from the day key, not from now + 24h", () => {
    // The shape this replaced computed the upper bound as `now + 86_400_000` and
    // then took ITS local day. Early on a fall-back morning that lands back on
    // *today*, and the two bounds resolve against different offsets — the old
    // `me/routes` code returned a ONE-hour window (04:00Z → 05:00Z) here.
    //
    // 04:30Z is 00:30 EDT on Nov 1; the local day runs 00:00 EDT → 00:00 EST.
    const { start, end } = newYork.dayBounds(new Date("2026-11-01T04:30:00.000Z"));
    assert.equal(start.toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(end.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(end.getTime() - start.getTime(), 25 * 3_600_000);
  });
});

describe("addDays / clock.startOf", () => {
  test("adds whole calendar days, crossing a month and a year", () => {
    assert.equal(addDays(day("2026-06-30"), 1), "2026-07-01");
    assert.equal(addDays(day("2026-01-01"), -1), "2025-12-31");
    assert.equal(addDays(day("2026-06-10"), 0), "2026-06-10");
  });

  test("day arithmetic is unaffected by a DST transition in between", () => {
    // +1 day across spring-forward is still the next calendar day, even though
    // the two midnights are 23 hours apart.
    assert.equal(addDays(day("2026-03-07"), 1), "2026-03-08");
    assert.equal(newYork.startOf(day("2026-03-08")).toISOString(), "2026-03-08T05:00:00.000Z");
  });

  test("startOf takes an hour, and resolves it against that hour's own offset", () => {
    // 09:00 on a normal EDT day is 13:00Z; on the spring-forward day the same
    // wall-clock 09:00 is still 13:00Z because the shift happened at 02:00.
    assert.equal(newYork.startOf(day("2026-06-10"), 9).toISOString(), "2026-06-10T13:00:00.000Z");
    assert.equal(newYork.startOf(day("2026-03-08"), 9).toISOString(), "2026-03-08T13:00:00.000Z");
    // Midnight is the default, so `startOf(key)` and `startOf(key, 0)` agree.
    assert.equal(
      newYork.startOf(day("2026-06-10")).getTime(),
      newYork.startOf(day("2026-06-10"), 0).getTime(),
    );
  });
});

describe("weekdayIndex", () => {
  test("reads the day of week off the key, with no locale in the path", () => {
    assert.equal(weekdayIndex(day("2026-06-14")), 0); // Sunday
    assert.equal(weekdayIndex(day("2026-06-10")), 3); // Wednesday
    assert.equal(weekdayIndex(day("2026-06-13")), 6); // Saturday
  });

  test("agrees with the rendered weekday name it replaced for decisions", () => {
    for (const key of ["2026-06-08", "2026-06-13", "2026-06-14", "2026-11-01"] as const) {
      const rendered = formatDay(day(key), "weekday");
      const isWeekendByName = rendered === "Saturday" || rendered === "Sunday";
      const index = weekdayIndex(day(key));
      assert.equal(index === 6 || index === 0, isWeekendByName, `mismatch on ${key}`);
    }
  });
});

describe("formatDay", () => {
  test("renders a key in each style", () => {
    assert.equal(formatDay(day("2026-06-11"), "short"), "Jun 11");
    assert.equal(formatDay(day("2026-06-10"), "long"), "Wednesday, 10 June 2026");
    assert.equal(formatDay(day("2026-06-13"), "weekday"), "Saturday");
  });

  test("a key at the far edges of the day still renders as itself", () => {
    // A key has no instant, so rendering it takes no zone at all — this is the
    // UTC+14 weekday-a-day-late defect, asserted at both extremes.
    assert.equal(formatDay(day("2026-01-01"), "long"), "Thursday, 1 January 2026");
    assert.equal(formatDay(day("2026-12-31"), "long"), "Thursday, 31 December 2026");
  });
});

describe("clock.format", () => {
  // The #284 evidence instant: a ClickUp notification received at 21:40 UTC,
  // which is 03:10 the next morning in India — the "late-night request" the
  // briefing must be able to phrase by local time.
  const overnight = new Date("2026-06-26T21:40:00.000Z");

  test("renders wall-clock in the bound zone, rolling the local date when needed", () => {
    const asia = kolkata.format(overnight);
    assert.ok(asia.includes("3:10 AM"), `expected 3:10 AM, got: ${asia}`);
    assert.ok(asia.includes("Jun 27"), `expected Jun 27 (date rolled), got: ${asia}`);
  });

  test("reflects a different timezone's offset", () => {
    const ny = newYork.format(overnight);
    assert.ok(ny.includes("5:40 PM"), `expected 5:40 PM (EDT), got: ${ny}`);
    assert.ok(ny.includes("Jun 26"), `expected Jun 26, got: ${ny}`);
  });
});

describe("clock.clock", () => {
  test("reports the date, time, weekday, and offset the user is reading", () => {
    assert.deepEqual(kolkata.clock(new Date("2026-07-14T16:20:11.000Z")), {
      localDate: "2026-07-14",
      localTime: "21:50:11",
      weekday: "Tuesday",
      utcOffset: "+05:30",
    });
  });

  test("rolls the local date backwards west of UTC just after UTC midnight", () => {
    assert.deepEqual(
      inZone(tz("America/Los_Angeles")).clock(new Date("2026-07-15T00:30:00.000Z")),
      {
        localDate: "2026-07-14",
        localTime: "17:30:00",
        weekday: "Tuesday",
        utcOffset: "-07:00",
      },
    );
  });

  test("reports midnight as 00, not 24", () => {
    assert.equal(utc.clock(new Date("2026-07-14T00:00:00.000Z")).localTime, "00:00:00");
  });

  test("renders a bare-GMT zone's offset as +00:00 rather than an empty string", () => {
    assert.equal(utc.clock(new Date("2026-07-14T12:00:00.000Z")).utcOffset, "+00:00");
  });

  test("follows the zone across its own DST transition", () => {
    assert.equal(newYork.clock(new Date("2026-01-14T12:00:00.000Z")).utcOffset, "-05:00");
    assert.equal(newYork.clock(new Date("2026-07-14T12:00:00.000Z")).utcOffset, "-04:00");
  });

  test("its localDate is a real key, not an assembled '--'", () => {
    // The prior version substituted "" for any missing `Intl` part, assembling
    // `localDate: "--"` / `localTime: "::"` and handing them to the model
    // verbatim via `system.current_time`. A key that can't be parsed is now a
    // throw, so this asserts the assembled value survives the parser.
    const reading = kolkata.clock(new Date("2026-07-14T16:20:11.000Z"));
    assert.equal(isLocalDateKey(reading.localDate), true);
    assert.match(reading.localTime, /^\d{2}:\d{2}:\d{2}$/);
  });
});
