import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { calendarListEventsInput } from "@alfred/contracts";
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
