import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { calendarListEventsInput, parseIanaTimezone } from "@alfred/contracts";
import { z } from "zod";
import { resolveCalendarListWindow } from "../../../src/tool-runtime/internal/tools/calendar";

const NOW = new Date("2026-06-07T05:00:00.000Z");

const UTC = parseIanaTimezone("UTC");

const KOLKATA = parseIanaTimezone("Asia/Kolkata");

describe("resolveCalendarListWindow", () => {
  test("computes tomorrow morning in the user's timezone", () => {
    const window = resolveCalendarListWindow(
      {
        window: "tomorrow",
        partOfDay: "morning",
        maxResults: 10,
      },
      KOLKATA,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-08T00:30:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-08T06:30:00.000Z");
    assert.equal(window.timezone, KOLKATA);
  });

  test("uses explicit bounds when relative fields are omitted", () => {
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-09T12:00:00.000Z",
        timeMax: "2026-06-09T13:00:00.000Z",
        maxResults: 10,
      },
      KOLKATA,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-09T12:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-09T13:00:00.000Z");
  });

  test("a relative window wins over redundant bounds that OVERLAP the same day", () => {
    // The model sends sloppy bounds that overlap the day plus a window. The window is the real
    // intent.
    const parsed = calendarListEventsInput.parse({
      timeMin: "2026-06-07T12:00:00.000Z",
      timeMax: "2026-06-08T12:00:00.000Z",
      window: "today",
      partOfDay: "full_day",
      maxResults: 10,
    });

    assert.equal((parsed as { window?: string }).window, "today");

    const window = resolveCalendarListWindow(
      {
        // Noon-to-noon bounds that overlap "today" (7 June).
        timeMin: "2026-06-07T12:00:00.000Z",
        timeMax: "2026-06-08T12:00:00.000Z",
        window: "today",
        partOfDay: "full_day",
        maxResults: 10,
      },
      UTC,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-07T00:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-08T00:00:00.000Z");
  });

  test("explicit bounds DISJOINT from the window are honored (deliberate specific-date ask)", () => {
    // "Events on 20 June" with a stray window: disjoint bounds are the deliberate intent.
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-20T09:00:00.000Z",
        timeMax: "2026-06-20T17:00:00.000Z",
        window: "today",
        partOfDay: "full_day",
        maxResults: 10,
      },
      UTC,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-20T09:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-20T17:00:00.000Z");
  });

  test("inverted bounds alongside a window fall back to the window (no bounce)", () => {
    // The bounds-only path throws on inverted bounds. With a window there is a fallback.
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-20T17:00:00.000Z",
        timeMax: "2026-06-20T09:00:00.000Z",
        window: "today",
        partOfDay: "full_day",
        maxResults: 10,
      },
      UTC,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-07T00:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-08T00:00:00.000Z");
  });

  test("explicit bounds are still honored when no relative window is set", () => {
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-09T12:00:00.000Z",
        timeMax: "2026-06-09T13:00:00.000Z",
        maxResults: 10,
      },
      KOLKATA,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-09T12:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-09T13:00:00.000Z");
  });

  test("defaults next_7_days to local midnight through seven days later", () => {
    const window = resolveCalendarListWindow(
      {
        window: "next_7_days",
        partOfDay: "full_day",
        maxResults: 10,
      },
      UTC,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-07T00:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-14T00:00:00.000Z");
  });

  test("rejects inverted explicit bounds", () => {
    assert.throws(
      () =>
        resolveCalendarListWindow(
          {
            timeMin: "2026-06-09T13:00:00.000Z",
            timeMax: "2026-06-09T12:00:00.000Z",
            maxResults: 10,
          },
          UTC,
          NOW,
        ),
      /timeMax to be after timeMin/,
    );
  });
});

describe("calendarListEventsInput datetime bounds", () => {
  // The model sends local offsets like `+05:30`, not only `Z`.
  test("accepts a trailing Z", () => {
    const r = calendarListEventsInput.safeParse({
      timeMin: "2026-06-26T00:00:00Z",
      timeMax: "2026-06-26T23:59:59Z",
    });

    assert.equal(r.success, true);
  });

  test("accepts a numeric UTC offset", () => {
    const r = calendarListEventsInput.safeParse({
      timeMin: "2026-06-26T00:00:00+05:30",
      timeMax: "2026-06-26T23:59:59+05:30",
    });

    assert.equal(r.success, true);
  });

  test("an offset bound still resolves to the correct UTC instant", () => {
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-26T00:00:00+05:30",
        timeMax: "2026-06-26T23:59:59+05:30",
        maxResults: 10,
      },
      KOLKATA,
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-25T18:30:00.000Z");
  });
});

describe("calendarListEventsInput window-key synonyms", () => {
  // The model guesses the key but sends a valid window value. Any key with a window value
  // becomes `window`.
  for (const key of ["timeframe", "range", "time_range", "period", "when", "anything"] as const) {
    test(`promotes ${key} → window when it carries a window value`, () => {
      const r = calendarListEventsInput.safeParse({ [key]: "tomorrow" });
      assert.equal(r.success, true);

      if (r.success) assert.equal((r.data as { window?: string }).window, "tomorrow");
    });
  }

  test("does not clobber an explicit window with a stray key", () => {
    const r = calendarListEventsInput.safeParse({ window: "tomorrow", range: "today" });
    assert.equal(r.success, false);
  });

  test("leaves a key carrying a non-window value to fail (no silent guess)", () => {
    const r = calendarListEventsInput.safeParse({ range: "this month" });
    assert.equal(r.success, false);
  });

  test("does not disturb a valid partOfDay (its values aren't window values)", () => {
    const r = calendarListEventsInput.safeParse({ window: "tomorrow", partOfDay: "morning" });
    assert.equal(r.success, true);

    if (r.success) {
      assert.equal((r.data as { window?: string }).window, "tomorrow");
      assert.equal((r.data as { partOfDay?: string }).partOfDay, "morning");
    }
  });

  test("still accepts the canonical window verbatim", () => {
    const r = calendarListEventsInput.safeParse({ window: "today" });
    assert.equal(r.success, true);
  });

  // Promotion is safe only while no other enum contains a window value like "today".
  test("no other declared field's enum overlaps the window value space", () => {
    const json = z.toJSONSchema(calendarListEventsInput, { io: "input" }) as {
      properties?: Record<string, { enum?: unknown[] }>;
    };

    const props = json.properties ?? {};
    const windowValues = new Set(props.window?.enum ?? []);
    assert.ok(windowValues.size > 0, "window enum should be advertised");

    for (const [key, schema] of Object.entries(props)) {
      if (key === "window" || !Array.isArray(schema.enum)) continue;

      for (const value of schema.enum) {
        assert.ok(
          !windowValues.has(value),
          `field "${key}" enum value ${JSON.stringify(value)} collides with a window value; ` +
            `promoteWindowSynonym would silently rename it to window`,
        );
      }
    }
  });
});
