import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  evaluateToolAvailability,
  type IntegrationAvailabilitySnapshot,
} from "../../../src/modules/integrations/availability";
import { liveTool } from "../../../src/modules/tools/registry";

/**
 * The default-OFF passthrough preference gate (ADR-0074). `evaluateToolAvailability`
 * is the single source both discovery/load and the dispatch recheck consult, so
 * these prove the `feature_disabled` code fires precisely: off (or unset) →
 * feature_disabled BEFORE any connection reason; on + connected → available; on
 * but disconnected → the honest health reason, not feature_disabled.
 */

const railwayGraphql = liveTool({
  integration: "railway",
  action: "graphql",
  riskTier: "no_risk",
  description: "Raw read-only Railway GraphQL.",
  availability: { passthrough: true },
  inputSchema: z.object({ document: z.string() }),
  execute: async () => ({}),
});

const ctx = { caller: "boss", hasThread: true } as const;

function snapshot(args: {
  railwayHealth?: "active" | "needs_reauth" | null;
  passthroughOn?: boolean;
}): IntegrationAvailabilitySnapshot {
  return {
    integrations: new Map(
      args.railwayHealth === undefined
        ? []
        : [["railway", { health: args.railwayHealth, accountLabel: null }]],
    ),
    providers: new Map(),
    passthroughEnabled: new Map(
      args.passthroughOn === undefined ? [] : [["railway", args.passthroughOn]],
    ),
  };
}

describe("passthrough preference gate (feature_disabled)", () => {
  test("an unset preference (absent from the map) is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: "active" }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("an explicitly-off preference is feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: "active", passthroughOn: false }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("preference ON + integration connected → available", () => {
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: "active", passthroughOn: true }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, true);
  });

  test("preference gate precedes the connection check: OFF + disconnected is feature_disabled, not not_connected", () => {
    // The user turned the tier off, so that is the honest reason regardless of
    // whether the integration is connected.
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: null, passthroughOn: false }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "feature_disabled");
  });

  test("preference ON but integration disconnected → honest connection reason, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: null, passthroughOn: true }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "not_connected");
  });

  test("preference ON but integration needs reauth → needs_reauth, not feature_disabled", () => {
    const result = evaluateToolAvailability(
      snapshot({ railwayHealth: "needs_reauth", passthroughOn: true }),
      railwayGraphql,
      new Set(),
      ctx,
    );
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "needs_reauth");
  });
});
