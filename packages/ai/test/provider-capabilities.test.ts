import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EFFORT_LEVELS, type EffortLevel, MODEL_CAPABILITIES, type ModelId } from "../src/models";
import {
  clampEffort,
  getChatProviderOptions,
  getRegisteredModelProviderOptions,
} from "../src/provider";

/**
 * The per-model capability map (ADR-0078) replaced the hardcoded tier→capability
 * branch in `getChatProviderOptions`. These offline invariants lock the two things
 * a future tier remap must never break: the tier-selected reasoning block, and
 * the clamp that keeps the dispatch from emitting an effort a model 400s on.
 */
describe("provider capability dispatch", () => {
  test("getChatProviderOptions follows the chat tier capability map", () => {
    // standard → Sonnet 4.6: adaptive thinking + clamped medium effort (ADR-0077 amendment).
    assert.deepEqual(getChatProviderOptions("standard"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
    });
    // deep → Opus 4.8: adaptive thinking + clamped effort.
    assert.deepEqual(getChatProviderOptions("deep"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
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

  test("Google dispatch maps effort models and preserves budget-based models", () => {
    assert.deepEqual(getRegisteredModelProviderOptions("gemini-3.5-flash", "xhigh"), {
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });
    assert.deepEqual(getRegisteredModelProviderOptions("gemini-2.5-flash", "medium"), {
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    });
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

    // Provider-specific vocabulary is represented, not silently dropped.
    assert.equal(clampEffort("low", ["minimal", "low", "medium", "high"]), "low");
    assert.equal(clampEffort("xhigh", ["minimal", "low", "medium", "high"]), "high");
    assert.equal(clampEffort("low", ["none", "low", "medium", "high", "xhigh"]), "low");
  });

  test("GPT-5.6 dispatch emits only supported Responses API effort values", () => {
    assert.deepEqual(getRegisteredModelProviderOptions("gpt-5.6-sol", "max"), {
      openai: { reasoningEffort: "max" },
    });
    assert.deepEqual(getRegisteredModelProviderOptions("gpt-5.6-luna", "minimal"), {
      openai: { reasoningEffort: "none" },
    });
  });
});
