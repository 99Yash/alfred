import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { route } from "../src/provider";

/**
 * The cheap route must never buy a reasoning budget (#436). It selects the
 * generic AI SDK `none` ceiling, which the provider package maps to its own
 * disabled shape, and carries no provider-option exception.
 */
describe("cheap model route", () => {
  test("selects disabled reasoning for the whole same-provider chain", () => {
    assert.equal(route("cheap").reasoning(), "none");
    assert.deepEqual(route("cheap").providerOptions(), {});
  });

  test("returns one memoized, attribution-preserving model handle", () => {
    const first = route("cheap").model();
    const second = route("cheap").model();

    assert.equal(first, second);
    assert.match(first.provider, /^google(?:\.|$)/);
    assert.equal(first.modelId, "gemini-2.5-flash-lite");
  });
});
