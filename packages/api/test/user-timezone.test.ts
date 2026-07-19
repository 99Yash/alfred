import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { firstValidTimezone } from "../src/modules/timezone/user-timezone";

describe("firstValidTimezone", () => {
  test("prefers the canonical timezone key over the briefing fallback", () => {
    assert.equal(firstValidTimezone(["America/New_York", "Asia/Kolkata"]), "America/New_York");
  });

  test("falls back to briefing.timezone when the canonical key is missing or invalid", () => {
    assert.equal(firstValidTimezone([undefined, "Asia/Kolkata"]), "Asia/Kolkata");
    assert.equal(firstValidTimezone(["Not/AZone", "Asia/Kolkata"]), "Asia/Kolkata");
  });

  test("falls back to UTC when neither preference contains a valid IANA timezone", () => {
    assert.equal(firstValidTimezone([null, ""]), "UTC");
  });
});
