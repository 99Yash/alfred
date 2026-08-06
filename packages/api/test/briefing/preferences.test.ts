import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
  resolveBriefingPreferenceValues,
} from "../../src/modules/briefing/preferences";

describe("resolveBriefingPreferenceValues", () => {
  test("prefers canonical timezone over the legacy briefing fallback", () => {
    const prefs = resolveBriefingPreferenceValues({
      timezoneValues: ["America/New_York", "Asia/Kolkata"],
      deliveryHour: undefined,
      eveningHour: undefined,
    });

    assert.equal(prefs.timezone, "America/New_York");
    assert.equal(prefs.hasUserOverride, true);
  });

  test("falls back to briefing.timezone when canonical timezone is missing or invalid", () => {
    assert.equal(
      resolveBriefingPreferenceValues({
        timezoneValues: [undefined, "Asia/Kolkata"],
        deliveryHour: undefined,
        eveningHour: undefined,
      }).timezone,
      "Asia/Kolkata",
    );
    assert.equal(
      resolveBriefingPreferenceValues({
        timezoneValues: ["Not/AZone", "Asia/Kolkata"],
        deliveryHour: undefined,
        eveningHour: undefined,
      }).timezone,
      "Asia/Kolkata",
    );
  });

  test("uses documented defaults when no valid timezone or hour preference exists", () => {
    const prefs = resolveBriefingPreferenceValues({
      timezoneValues: ["", null],
      deliveryHour: "99",
      eveningHour: {},
    });

    assert.equal(prefs.timezone, DEFAULT_BRIEFING_TIMEZONE);
    assert.equal(prefs.deliveryHour, DEFAULT_BRIEFING_DELIVERY_HOUR);
    assert.equal(prefs.eveningHour, DEFAULT_BRIEFING_EVENING_HOUR);
    assert.equal(prefs.hasUserOverride, false);
  });

  test("parses stringified delivery hours as user overrides", () => {
    const prefs = resolveBriefingPreferenceValues({
      timezoneValues: [undefined, undefined],
      deliveryHour: "8",
      eveningHour: 19,
    });

    assert.equal(prefs.deliveryHour, 8);
    assert.equal(prefs.eveningHour, 19);
    assert.equal(prefs.hasUserOverride, true);
  });
});
