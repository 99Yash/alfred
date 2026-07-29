import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { route } from "../src/provider";

/**
 * The cheap route must never buy a reasoning budget (#436). Both the primary
 * and fallback are derived from this route policy, and model construction uses
 * the same provider-options value as its default settings.
 */
describe("cheap model route", () => {
  test("projects disabled reasoning for the whole same-provider chain", () => {
    assert.deepEqual(route("cheap").providerOptions(), {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  test("returns one memoized, attribution-preserving model handle", () => {
    const first = route("cheap").model();
    const second = route("cheap").model();

    assert.equal(first, second);
    assert.match(first.provider, /^google(?:\.|$)/);
    assert.equal(first.modelId, "gemini-2.5-flash-lite");
  });
});
