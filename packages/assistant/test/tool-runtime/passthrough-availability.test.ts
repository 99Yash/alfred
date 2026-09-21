import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";
import { z } from "zod";
import { liveTool } from "@alfred/assistant/tool-runtime";
import { evaluateToolAvailability } from "../../src/tool-runtime/internal/registry";

/**
 * The default-OFF passthrough preference gate (ADR-0074). `evaluateToolAvailability`
 * is the single source both discovery/load and the dispatch recheck consult, so
 * these prove the `feature_disabled` code fires precisely: off (or unset) →
 * feature_disabled BEFORE any connection reason; on + connected → available; on
 * but disconnected → the honest health reason, not feature_disabled.
 */

const notionRequest = liveTool({
  integration: "notion",
  action: "request",
  riskTier: "no_risk",
  description: "Raw read-only Notion request.",
  availability: { passthrough: true },
  inputSchema: z.object({ document: z.string() }),
  execute: async () => ({}),
});

const ctx = { caller: "boss", interaction: "live_chat" } as const;

function snapshot(args: {
  notionHealth?: "active" | "needs_reauth" | null;
  passthroughOn?: boolean;
}): IntegrationAvailabilitySnapshot {
  return {
    integrations: new Map(
      args.notionHealth === undefined
        ? []
        : [["notion", { health: args.notionHealth, accountLabel: null }]],
    ),
    providers: new Map(),
    passthroughEnabled: new Map(
      args.passthroughOn === undefined ? [] : [["notion", args.passthroughOn]],
    ),
  };
}

describe("passthrough preference gate (feature_disabled)", () => {
  test("an unset preference (absent from the map) is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: "active" }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("an explicitly-off preference is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: "active", passthroughOn: false }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("preference ON + integration connected → available", () => {
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: "active", passthroughOn: true }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, true);
  });

  test("preference gate precedes the connection check: OFF + disconnected is feature_disabled, not not_connected", () => {
    // The user turned the tier off, so that is the honest reason regardless of
    // whether the integration is connected.
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: null, passthroughOn: false }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("preference ON but integration disconnected → honest connection reason, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: null, passthroughOn: true }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    if (!result.available) assert.equal(result.code, "not_connected");
  });

  test("preference ON but integration needs reauth → needs_reauth, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ notionHealth: "needs_reauth", passthroughOn: true }),
      notionRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    if (!result.available) assert.equal(result.code, "needs_reauth");
  });
});
