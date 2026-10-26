import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { route, routeEffort } from "../src/provider";

/** The cheap route must never buy a reasoning budget: generic `none`. */
describe("cheap model route", () => {
  test("selects disabled reasoning for the whole same-provider chain", () => {
    assert.equal(routeEffort("cheap"), "none");
  });

  test("returns one memoized, attribution-preserving model handle", () => {
    const first = route("cheap").model();
    const second = route("cheap").model();

    assert.equal(first, second);
    assert.match(first.provider, /^google(?:\.|$)/);
    assert.equal(first.modelId, "gemini-2.5-flash-lite");
  });
});
