import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatInstantInTimezone } from "../src/modules/timezone";

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
