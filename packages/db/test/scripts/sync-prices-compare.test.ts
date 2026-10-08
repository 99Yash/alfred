import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { auditedMetadataEqual, pricesEqual } from "@alfred/db/scripts/sync-prices-compare";

/**
 * `jsonb` reorders object keys (by length, then bytewise), so comparing with
 * `JSON.stringify` made every row look changed and `db:sync-prices` wrote a new
 * snapshot on each run. The fixtures are real read-back shapes; `canonicalJson` handles them.
 */
describe("auditedMetadataEqual", () => {
  test("ignores the key order jsonb imposes on the stored value", () => {
    // Written by the script as { cacheWrite1hPerMtok, tiers }; read back sorted.
    const stored = {
      source: "models.dev",
      pricing: { tiers: [], cacheWrite1hPerMtok: 20 },
      capabilities: {
        reasoning: true,
        toolCall: true,
        temperature: false,
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
    };

    const incoming = {
      pricing: { cacheWrite1hPerMtok: 20, tiers: [] },
      capabilities: {
        reasoning: true,
        toolCall: true,
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
        temperature: false,
      },
    };

    assert.equal(auditedMetadataEqual(stored, incoming), true);
  });

  test("ignores key order inside nested tier objects", () => {
    const stored = {
      pricing: {
        tiers: [{ inputPerMtok: 8, outputPerMtok: 30, minInputTokens: 272_000 }],
        cacheWrite1hPerMtok: null,
      },
    };

    const incoming = {
      pricing: {
        cacheWrite1hPerMtok: null,
        tiers: [{ minInputTokens: 272_000, inputPerMtok: 8, outputPerMtok: 30 }],
      },
    };

    assert.equal(auditedMetadataEqual(stored, incoming), true);
  });

  // The tests above only mean something if the comparison can still say "no".
  test("reports a changed price tier", () => {
    const stored = { pricing: { tiers: [], cacheWrite1hPerMtok: 20 } };
    const incoming = { pricing: { cacheWrite1hPerMtok: 24, tiers: [] } };
    assert.equal(auditedMetadataEqual(stored, incoming), false);
  });

  test("reports a changed effort vocabulary", () => {
    // The ADR-0078 audit oracle: a new effort value must land a fresh snapshot.
    const stored = {
      capabilities: { reasoningOptions: [{ type: "effort", values: ["low", "high"] }] },
    };

    const incoming = {
      capabilities: { reasoningOptions: [{ type: "effort", values: ["low", "high", "max"] }] },
    };

    assert.equal(auditedMetadataEqual(stored, incoming), false);
  });

  test("reports changed temperature support", () => {
    assert.equal(
      auditedMetadataEqual(
        { capabilities: { temperature: true } },
        {
          capabilities: { temperature: false },
        },
      ),
      false,
    );
  });

  test("treats array order as significant", () => {
    // Effort vocabularies are ordered low→high; a reordering is a real change.
    const stored = { capabilities: { reasoningOptions: [{ values: ["low", "high"] }] } };
    const incoming = { capabilities: { reasoningOptions: [{ values: ["high", "low"] }] } };
    assert.equal(auditedMetadataEqual(stored, incoming), false);
  });

  test("matches the static rows, which carry no audited metadata", () => {
    // Voyage rows carry only `source`, so key order never mattered for them.
    assert.equal(auditedMetadataEqual({ source: "static" }, undefined), true);
  });

  test("tolerates a non-object stored metadata", () => {
    assert.equal(auditedMetadataEqual(null, undefined), true);
  });
});

describe("pricesEqual", () => {
  const base = {
    inputPerMtok: 10,
    outputPerMtok: 50,
    cachedInputPerMtok: 1,
    cacheWriteInputPerMtok: 12.5,
    perCallUsd: null,
    contextWindow: 1_000_000,
  };

  test("matches identical pricing", () => {
    assert.equal(pricesEqual(base, { ...base }), true);
  });

  test("separates null from zero", () => {
    // A NULL cache-read rate means "unsupported"; 0 means "free". Different.
    assert.equal(pricesEqual(base, { ...base, cachedInputPerMtok: 0 }), false);
  });

  test("reports a changed context window", () => {
    assert.equal(pricesEqual(base, { ...base, contextWindow: 200_000 }), false);
  });
});
