import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GENERAL_INVOCATION_COVERAGE,
  LOADABLE_INTEGRATION_SLUGS,
  PASSTHROUGH_PREFERENCE_KEYS,
  PASSTHROUGH_TRANSPORT,
  SUPPORTED_PASSTHROUGH_SLUGS,
  SUPPORTED_REST_PASSTHROUGH_SLUGS,
  isPassthroughPreferenceOn,
  isSupportedPassthroughSlug,
  passthroughPreferenceKey,
} from "@alfred/contracts";
import { REST_GATE_CONFIG } from "../../../src/modules/tools/passthrough";

describe("general-invocation coverage registry", () => {
  test("every loadable integration slug has a coverage decision (no silent drift)", () => {
    const covered = Object.keys(GENERAL_INVOCATION_COVERAGE).sort();
    assert.deepEqual(covered, [...LOADABLE_INTEGRATION_SLUGS].sort());
  });

  test("the supported list matches the coverage map exactly", () => {
    const supported = LOADABLE_INTEGRATION_SLUGS.filter(
      (slug) => GENERAL_INVOCATION_COVERAGE[slug] === "supported",
    ).sort();
    assert.deepEqual([...SUPPORTED_PASSTHROUGH_SLUGS].sort(), supported);
  });

  test("v1 classifications are pinned", () => {
    assert.equal(GENERAL_INVOCATION_COVERAGE.slack, "deferred");
    assert.equal(GENERAL_INVOCATION_COVERAGE.linear, "deferred");
    assert.equal(GENERAL_INVOCATION_COVERAGE.imessage, "not_applicable");
    for (const slug of ["gmail", "github", "notion", "railway", "vercel"] as const) {
      assert.equal(GENERAL_INVOCATION_COVERAGE[slug], "supported", slug);
    }
  });

  test("isSupportedPassthroughSlug agrees with the registry", () => {
    assert.equal(isSupportedPassthroughSlug("github"), true);
    assert.equal(isSupportedPassthroughSlug("slack"), false);
    assert.equal(isSupportedPassthroughSlug("imessage"), false);
    assert.equal(isSupportedPassthroughSlug("not_a_slug"), false);
  });
});

describe("REST gate config ↔ coverage agreement", () => {
  test("every supported REST slug has exactly one gate config entry", () => {
    assert.deepEqual(
      Object.keys(REST_GATE_CONFIG).sort(),
      [...SUPPORTED_REST_PASSTHROUGH_SLUGS].sort(),
    );
  });

  test("Railway is GraphQL transport and has no REST gate config", () => {
    assert.equal(PASSTHROUGH_TRANSPORT.railway, "graphql");
    assert.ok(!("railway" in REST_GATE_CONFIG));
  });

  test("deferred / not-applicable slugs expose no gate config", () => {
    for (const slug of ["slack", "linear", "imessage"]) {
      assert.ok(!(slug in REST_GATE_CONFIG), slug);
    }
  });
});

describe("passthrough preference (default OFF)", () => {
  test("only an explicit truthy value enables the tier", () => {
    assert.equal(isPassthroughPreferenceOn(true), true);
    assert.equal(isPassthroughPreferenceOn("true"), true);
    assert.equal(isPassthroughPreferenceOn(1), true);
  });

  test("an unset row (undefined) or any falsy value is OFF", () => {
    for (const v of [undefined, null, false, "false", 0, "", "no"]) {
      assert.equal(isPassthroughPreferenceOn(v), false, JSON.stringify(v));
    }
  });

  test("preference keys are namespaced per supported slug", () => {
    assert.equal(passthroughPreferenceKey("github"), "feature.passthrough.github");
    for (const slug of SUPPORTED_PASSTHROUGH_SLUGS) {
      assert.equal(PASSTHROUGH_PREFERENCE_KEYS[slug], `feature.passthrough.${slug}`);
    }
  });
});
