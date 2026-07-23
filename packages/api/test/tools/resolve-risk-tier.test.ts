import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";

import { liveTool, type ToolExecuteContext } from "../../src/modules/tools/registry";

/**
 * Deterministic (no-DB) coverage of the `resolveRiskTier` wiring seam (#541 Part
 * 3). The DB-backed `test/mcp/risk.test.ts` proves the resolver's fail-closed
 * branches; this proves the REGISTRY half the resolver rides on:
 *
 *  - the static `riskTier` is preserved as the floor on the registry entry;
 *  - `resolveRiskTier` is opt-in — a tool that omits it exposes no hook, so the
 *    dispatcher falls back to the static tier;
 *  - the registry wrapper re-parses raw input through `inputSchema` before the
 *    resolver sees it, so the resolver operates on the SAME validated shape the
 *    approval decision and the persisted staging row are built from.
 *
 * `mcp.call` is used only as a valid `(integration, action)` pair; the schema is
 * a stand-in chosen to make the re-parse observable via coercion.
 */
describe("liveTool resolveRiskTier wiring", () => {
  const ctx = {
    runId: "run_1",
    scratchpadRunId: "run_1",
    stepId: "step_1",
    toolCallId: "call_1",
    userId: "user_1",
    timezone: "UTC",
    caller: "boss",
  } satisfies ToolExecuteContext;

  test("preserves the static riskTier as the floor on the registry entry", () => {
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.coerce.number() }),
      resolveRiskTier: async () => "low",
      execute: async () => ({ ok: true }),
    });
    assert.equal(tool.riskTier, "high");
  });

  test("a tool without the hook exposes no resolveRiskTier (static fallback)", () => {
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.coerce.number() }),
      execute: async () => ({ ok: true }),
    });
    assert.equal(tool.resolveRiskTier, undefined);
  });

  test("re-parses raw input through inputSchema before the resolver sees it", async () => {
    let seen: unknown;
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.coerce.number() }),
      resolveRiskTier: async (input) => {
        seen = input;
        return "low";
      },
      execute: async () => ({ ok: true }),
    });

    // Raw input carries a string `n`; the coercing schema turns it into a number.
    const tier = await tool.resolveRiskTier?.({ n: "3" }, ctx);
    assert.equal(tier, "low");
    assert.deepEqual(seen, { n: 3 }, "the resolver receives the parsed (coerced) input");
  });
});
