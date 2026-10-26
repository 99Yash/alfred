import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";
import { z } from "zod";
import { liveTool } from "@alfred/assistant/tool-runtime";
import { evaluateToolAvailability } from "../../src/tool-runtime/internal/registry";

/**
 * The passthrough preference gate, off by default (ADR-0074). Off returns `feature_disabled`
 * before any connection reason. On but disconnected returns the health reason.
 */

const vercelRequest = liveTool({
  integration: "vercel",
  action: "request",
  riskTier: "no_risk",
  description: "Raw read-only Vercel request.",
  availability: { passthrough: true },
  inputSchema: z.object({ document: z.string() }),
  execute: async () => ({ outcome: "rejected", reason: "method_not_read", message: "test double" }),
});

const ctx = { caller: "boss", interaction: "live_chat" } as const;

function snapshot(args: {
  vercelHealth?: "active" | "needs_reauth" | null;
  passthroughOn?: boolean;
}): IntegrationAvailabilitySnapshot {
  return {
    integrations: new Map(
      args.vercelHealth === undefined
        ? []
        : [["vercel", { health: args.vercelHealth, accountLabel: null }]],
    ),
    providers: new Map(),
    passthroughEnabled: new Map(
      args.passthroughOn === undefined ? [] : [["vercel", args.passthroughOn]],
    ),
  };
}

describe("passthrough preference gate (feature_disabled)", () => {
  test("an unset preference (absent from the map) is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: "active" }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    assert.equal(result.code, "feature_disabled");
  });

  test("an explicitly-off preference is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: "active", passthroughOn: false }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    assert.equal(result.code, "feature_disabled");
  });

  test("preference ON + integration connected → available", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: "active", passthroughOn: true }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, true);
  });

  test("preference gate precedes the connection check: OFF + disconnected is feature_disabled, not not_connected", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: null, passthroughOn: false }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    assert.equal(result.code, "feature_disabled");
  });

  test("preference ON but integration disconnected → honest connection reason, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: null, passthroughOn: true }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    assert.equal(result.code, "not_connected");
  });

  test("preference ON but integration needs reauth → needs_reauth, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ vercelHealth: "needs_reauth", passthroughOn: true }),
      vercelRequest,
      new Set(),
      ctx,
    );

    assert.equal(result.available, false);

    assert.equal(result.code, "needs_reauth");
  });
});
