import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { calendarListEventsInput } from "@alfred/contracts";
import { z } from "zod";
import {
  acceptedParamNames,
  enrichInvalidInputMessage,
} from "../../src/modules/dispatch/invalid-input";

describe("enrichInvalidInputMessage", () => {
  test("appends the accepted params when the model invents an unknown key", () => {
    // `gibberish` is not a real param, and its value isn't a window value, so
    // it isn't promoted to `window` — it trips strict validation. (A key
    // carrying a real window value like "today" WOULD be promoted, which is why
    // the value here is deliberately not one.)
    const parsed = calendarListEventsInput.safeParse({ gibberish: "nonsense" });
    assert.equal(parsed.success, false);
    if (parsed.success) return;
    const enriched = enrichInvalidInputMessage(
      parsed.error.message,
      calendarListEventsInput,
      parsed.error.issues,
    );
    assert.match(enriched, /This tool accepts only these parameters:/);
    // The field the model SHOULD have used is now surfaced for self-correction.
    assert.match(enriched, /window/);
    assert.match(enriched, /timeMin, timeMax, window, partOfDay, maxResults/);
  });

  test("leaves non-unrecognized-key errors untouched", () => {
    // A malformed value (not an unknown key) should pass through verbatim.
    const parsed = calendarListEventsInput.safeParse({ timeMin: "not-a-datetime" });
    assert.equal(parsed.success, false);
    if (parsed.success) return;
    const enriched = enrichInvalidInputMessage(
      parsed.error.message,
      calendarListEventsInput,
      parsed.error.issues,
    );
    assert.equal(enriched, parsed.error.message);
    assert.doesNotMatch(enriched, /This tool accepts only/);
  });

  test("acceptedParamNames returns the schema's top-level keys", () => {
    assert.deepEqual(acceptedParamNames(calendarListEventsInput), [
      "timeMin",
      "timeMax",
      "window",
      "partOfDay",
      "maxResults",
    ]);
  });

  test("acceptedParamNames is best-effort and never throws", () => {
    // A schema with no object properties yields an empty list rather than an error.
    assert.deepEqual(acceptedParamNames(z.string()), []);
  });
});
