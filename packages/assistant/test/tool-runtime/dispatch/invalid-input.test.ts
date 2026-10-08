import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { calendarListEventsInput } from "@alfred/contracts";
import { z } from "zod";
import {
  acceptedParamNames,
  enrichInvalidInputMessage,
} from "../../../src/tool-runtime/internal/dispatch/invalid-input";

describe("enrichInvalidInputMessage", () => {
  test("appends the accepted params when the model invents an unknown key", () => {
    // Not a window value on purpose: a key holding "today" would be promoted to `window`.
    const parsed = calendarListEventsInput.safeParse({ gibberish: "nonsense" });
    assert.equal(parsed.success, false);

    if (parsed.success) return;

    const enriched = enrichInvalidInputMessage(
      parsed.error.message,
      calendarListEventsInput,
      parsed.error.issues,
    );

    assert.match(enriched, /This tool accepts only these parameters:/);
    assert.match(enriched, /window/);
    assert.match(enriched, /timeMin, timeMax, window, partOfDay, maxResults/);
  });

  test("leaves non-unrecognized-key errors untouched", () => {
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
    assert.deepEqual(acceptedParamNames(z.string()), []);
  });
});
