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
    // standard → Luna primary + 3.8-flash fallback (ADR-0077 amendment
    // 2026-09-03d: Anthropic leaves both chat tiers). Both legs carry the
    // tier's `medium`: OpenAI Responses as flat `reasoningEffort`, Google as a
    // `thinkingLevel`. Two providers, so the merge must keep both bags — an
    // assertion that catches a chain edit dropping a leg's options.
    // `store: false` is load-bearing, not hygiene: Cloudflare Unified Billing
    // puts Alfred on a Zero Data Retention org, so replaying a reasoning item
    // by `rs_…` id 400s and kills the turn. See OPENAI_ZERO_DATA_RETENTION_STORE.
    assert.deepEqual(route("standard").providerOptions(), {
      openai: { reasoningEffort: "medium", store: false },
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
    });
    // deep → the same Luna at `max`, which is in its vocabulary; the Gemini
    // leg clamps `max` to its strongest value `high`.
    assert.deepEqual(route("deep").providerOptions(), {
      openai: { reasoningEffort: "max", store: false },
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
    // `store: false` rides every OpenAI bag, clamped effort or not — the Zero
    // Data Retention org cannot resolve a replayed `rs_…` reasoning item id.
    assert.deepEqual(route("gpt-5.6-sol", "max").providerOptions(), {
      openai: { reasoningEffort: "max", store: false },
    });
    assert.deepEqual(route("gpt-5.6-luna", "minimal").providerOptions(), {
      openai: { reasoningEffort: "none", store: false },
    });
  });
});
