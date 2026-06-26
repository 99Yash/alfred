import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { calendarListEventsInput } from "@alfred/contracts";
import { z } from "zod";
import { resolveCalendarListWindow } from "../../src/modules/tools/calendar";

const NOW = new Date("2026-06-07T05:00:00.000Z");

describe("resolveCalendarListWindow", () => {
  test("computes tomorrow morning in the user's timezone", () => {
    const window = resolveCalendarListWindow(
      {
        window: "tomorrow",
        partOfDay: "morning",
        maxResults: 10,
      },
      "Asia/Kolkata",
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-08T00:30:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-08T06:30:00.000Z");
    assert.equal(window.timezone, "Asia/Kolkata");
  });

  test("uses explicit bounds when relative fields are omitted", () => {
    const window = resolveCalendarListWindow(
      {
        timeMin: "2026-06-09T12:00:00.000Z",
        timeMax: "2026-06-09T13:00:00.000Z",
        maxResults: 10,
      },
      "Asia/Kolkata",
      NOW,
    );

    assert.equal(window.timeMin.toISOString(), "2026-06-09T12:00:00.000Z");
    assert.equal(window.timeMax.toISOString(), "2026-06-09T13:00:00.000Z");
  });

  test("rejects mixed explicit and relative input modes", () => {
    assert.throws(
      () =>
        calendarListEventsInput.parse({
          timeMin: "2026-06-09T12:00:00.000Z",
          timeMax: "2026-06-09T13:00:00.000Z",
          window: "tomorrow",
          maxResults: 10,
        }),
      /explicit timeMin\/timeMax/,
    );
    assert.throws(
      () =>
        resolveCalendarListWindow(
          {
            timeMin: "2026-06-09T12:00:00.000Z",
            timeMax: "2026-06-09T13:00:00.000Z",
            window: "tomorrow",
            maxResults: 10,
          },
          "Asia/Kolkata",
          NOW,
        ),
      /either explicit timeMin\/timeMax/,
    );
  });

  test("defaults next_7_days to local midnight through seven days later", () => {
    const window = resolveCalendarListWindow(
      {
        window: "next_7_days",
        partOfDay: "full_day",
        maxResults: 10,
      },
      "UTC",
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
          "UTC",
          NOW,
        ),
      /timeMax to be after timeMin/,
    );
  });
});

describe("calendarListEventsInput datetime bounds", () => {
  // Regression (run_wdtn451w1zp0): asked for "today" the model fell back to
  // explicit bounds expressed in the user's local UTC offset (`+05:30`). The
  // schema used to require a `Z` suffix and rejected it, costing an extra
  // retry. Both a trailing `Z` and a numeric offset must validate.
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
      "Asia/Kolkata",
      NOW,
    );
    // +05:30 local midnight is the prior 18:30 UTC.
    assert.equal(window.timeMin.toISOString(), "2026-06-25T18:30:00.000Z");
  });
});

describe("calendarListEventsInput window-key synonyms", () => {
  // Regression (run_w648c33jvwxo / run_bwo3shcjqp84): the model reliably emits
  // the right relative value but keeps guessing the key — `range`, `timeframe`,
  // `time_range`, … Promotion is value-driven (any key holding a real window
  // value is renamed to `window`), so it's robust to whatever synonym appears.
  for (const key of ["timeframe", "range", "time_range", "period", "when", "anything"] as const) {
    test(`promotes ${key} → window when it carries a window value`, () => {
      const r = calendarListEventsInput.safeParse({ [key]: "tomorrow" });
      assert.equal(r.success, true);
      if (r.success) assert.equal((r.data as { window?: string }).window, "tomorrow");
    });
  }

  test("does not clobber an explicit window with a stray key", () => {
    const r = calendarListEventsInput.safeParse({ window: "tomorrow", range: "today" });
    // window already set → no promotion → strict rejects the stray key.
    assert.equal(r.success, false);
  });

  test("leaves a key carrying a non-window value to fail (no silent guess)", () => {
    // `range:"this month"` is not a real window value — must not be promoted; it
    // falls through to a strict unrecognized-key error instead of being coerced.
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

  // Value-driven promotion is only safe while the window values are disjoint
  // from every other field's value space (see promoteWindowSynonym's comment):
  // if a future enum field gained a value like "today", a legitimate call would
  // be silently renamed to `window`. Assert that invariant structurally off the
  // advertised JSON Schema so adding an overlapping enum fails CI here, not in
  // production (#286 review).
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
