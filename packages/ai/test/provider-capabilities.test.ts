import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EFFORT_LEVELS, type EffortLevel, MODEL_CAPABILITIES, type ModelId } from "../src/models";
import { clampEffort, getChatProviderOptions } from "../src/provider";

/**
 * The per-model capability map (ADR-0078) replaced the hardcoded tier→capability
 * branch in `getChatProviderOptions`. These offline invariants lock the two things
 * a future tier remap must never break: the wire-identical reasoning block today,
 * and the clamp that keeps the dispatch from emitting an effort a model 400s on.
 */
describe("provider capability dispatch", () => {
  test("getChatProviderOptions is wire-identical to the pre-#313 hardcoding", () => {
    // standard → Haiku 4.5 (effortValues:[]): empty anthropic block (ADR-0077).
    assert.deepEqual(getChatProviderOptions("standard"), {
      anthropic: {},
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    });
    // deep → Opus 4.8: adaptive thinking + clamped effort.
    assert.deepEqual(getChatProviderOptions("deep"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    });
  });

  test("every model's effortValues is an ordered subset of EFFORT_LEVELS", () => {
    // clampEffort indexes into EFFORT_LEVELS, so an out-of-order or unknown value
    // would silently mis-clamp. This pins the invariant the clamp relies on.
    for (const [id, caps] of Object.entries(MODEL_CAPABILITIES) as [
      ModelId,
      { effortValues: readonly EffortLevel[] },
    ][]) {
      const indices = caps.effortValues.map((v) => EFFORT_LEVELS.indexOf(v));
      assert.ok(
        indices.every((i) => i >= 0),
        `${id} has an effort value outside EFFORT_LEVELS`,
      );
      assert.deepEqual(
        indices,
        [...indices].sort((a, b) => a - b),
        `${id} effortValues must be weakest→strongest`,
      );
    }
  });

  test("clampEffort snaps a requested effort to the nearest allowed value", () => {
    const opus = MODEL_CAPABILITIES["claude-opus-4-8"].effortValues; // full set
    assert.equal(clampEffort("high", opus), "high"); // identity when present
    assert.equal(clampEffort("max", opus), "max");

    const sonnet = MODEL_CAPABILITIES["claude-sonnet-4-6"].effortValues; // no "xhigh"
    // "xhigh" (index 3) is absent on sonnet; nearest is "high" (3) over "max" (4).
    assert.equal(clampEffort("xhigh", sonnet), "high");

    // A model exposing only one tier always returns it.
    assert.equal(clampEffort("max", ["low"]), "low");
  });
});
