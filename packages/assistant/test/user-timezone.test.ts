import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { firstValidTimezone, TIMEZONE_PREFERENCE_KEYS } from "../src/time/user-timezone";
// Reached through the module index — the pure `timezone` module now owns the
// IANA-zone validity check, so cross-module callers no longer route it through
// `briefing`.
import { isValidTimezone } from "@alfred/assistant/time";

describe("TIMEZONE_PREFERENCE_KEYS", () => {
  test("owns the ADR-0082 canonical-first key-set and order (canonical, then legacy)", () => {
    assert.deepEqual(TIMEZONE_PREFERENCE_KEYS, ["timezone", "briefing.timezone"]);
  });
});

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

describe("isValidTimezone (via the timezone index)", () => {
  test("accepts a real IANA zone", () => {
    assert.equal(isValidTimezone("America/New_York"), true);
  });

  test("accepts the UTC alias that supportedValuesOf alone omits", () => {
    assert.equal(isValidTimezone("UTC"), true);
    assert.equal(isValidTimezone("Etc/UTC"), true);
  });

  test("rejects a garbage string", () => {
    assert.equal(isValidTimezone("Not/AZone"), false);
  });

  test("rejects a non-string", () => {
    assert.equal(isValidTimezone(42), false);
    assert.equal(isValidTimezone(null), false);
  });
});
