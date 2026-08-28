import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  type ModelId,
  parseProviderModelIdentity,
} from "../src/models";
import { route } from "../src/provider";

/**
 * The per-model capability map (ADR-0078) replaced the hardcoded tier→capability
 * branch in `route`. These offline invariants lock the two things
 * a future tier remap must never break: the tier-selected reasoning block, and
 * the clamp that keeps the dispatch from emitting an effort a model 400s on.
 */
describe("provider capability dispatch", () => {
  test("route follows the chat tier capability map", () => {
    // standard → Sonnet 4.6: adaptive thinking + clamped medium effort (ADR-0077 amendment).
    // Fallback is gemini-2.5-flash (budget-based, no thinkingLevel) via Cloudflare unified billing.
    assert.deepEqual(route("standard").providerOptions(), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    });
    // deep → Opus 4.8: adaptive thinking + clamped effort.
    assert.deepEqual(route("deep").providerOptions(), {
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

  test("native tool search support is code-resident and fails closed for unprobed models", () => {
    assert.equal(MODEL_CAPABILITIES["claude-sonnet-4-6"].nativeToolSearch, true);
    assert.equal(MODEL_CAPABILITIES["claude-opus-4-8"].nativeToolSearch, true);
    assert.equal(MODEL_CAPABILITIES["claude-haiku-4-5-20251001"].nativeToolSearch, false);
    assert.equal(MODEL_CAPABILITIES["gemini-3.5-flash"].nativeToolSearch, false);
    assert.equal(MODEL_CAPABILITIES["gpt-5.6-sol"].nativeToolSearch, true);
  });

  test("external provider/model identities must match the canonical registry", () => {
    assert.deepEqual(
      parseProviderModelIdentity({ provider: "anthropic", modelId: "claude-sonnet-4-6" }),
      { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    );

    assert.throws(
      () => parseProviderModelIdentity({ provider: "google", modelId: "claude-sonnet-4-6" }),
      /registered to anthropic, not google/,
    );
    assert.throws(
      () => parseProviderModelIdentity({ provider: "anthropic", modelId: "unknown-model" }),
      /Invalid option/,
    );

    for (const [modelId, provider] of Object.entries(MODEL_REGISTRY)) {
      assert.deepEqual(parseProviderModelIdentity({ provider, modelId }), { provider, modelId });
    }
  });

  test("Google dispatch maps effort models and preserves budget-based models", () => {
    assert.deepEqual(route("gemini-3.5-flash", "xhigh").providerOptions(), {
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });
    assert.deepEqual(route("gemini-2.5-flash", "medium").providerOptions(), {
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    });
  });

  test("GPT-5.6 dispatch emits only supported Responses API effort values", () => {
    assert.deepEqual(route("gpt-5.6-sol", "max").providerOptions(), {
      openai: { reasoningEffort: "max" },
    });
    assert.deepEqual(route("gpt-5.6-luna", "minimal").providerOptions(), {
      openai: { reasoningEffort: "none" },
    });
  });
});
