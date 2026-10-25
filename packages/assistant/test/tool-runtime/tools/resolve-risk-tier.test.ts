import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { parseIanaTimezone } from "@alfred/contracts";

import { toolExecuteContext } from "@alfred/assistant/tool-runtime/context";
import { liveTool, type BoundToolCall, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { resolveEffectiveRiskTier } from "../../../src/tool-runtime/internal/dispatch";

/**
 * The registry half of `resolveRiskTier`. `test/mcp/risk.test.ts` covers the resolver.
 * `bind` parses input through `inputSchema`, so the resolver sees the validated shape.
 * `mcp.call` is only a valid name. The coercing schema makes the parse visible.
 */
function bound(tool: RegisteredTool, input: unknown): BoundToolCall {
  const binding = tool.bind(input);
  assert.ok(binding.success, "the fixture input must parse");

  return binding.call;
}

describe("liveTool resolveRiskTier wiring", () => {
  const ctx = toolExecuteContext({
    runId: "run_1",
    scratchpadRunId: "run_1",
    stepId: "step_1",
    toolCallId: "call_1",
    userId: "user_1",
    timezone: parseIanaTimezone("UTC"),
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    activeTools: [],
  });

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

  test("a tool without the hook does not resolve its tier from input (static fallback)", () => {
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.coerce.number() }),
      execute: async () => ({ ok: true }),
    });

    assert.equal(tool.resolvesRiskTier, false);
  });

  test("parses raw input through inputSchema before the resolver sees it", async () => {
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

    const tier = await bound(tool, { n: "3" }).declaredRiskTier(ctx);
    assert.equal(tier, "low");
    assert.deepEqual(seen, { n: 3 }, "the resolver receives the parsed (coerced) input");
  });

  test("centrally clamps an undeclared downgrade to the static tier", async () => {
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.number() }),
      resolveRiskTier: async () => "low",
      execute: async () => ({ ok: true }),
    });

    assert.equal(await resolveEffectiveRiskTier(bound(tool, { n: 3 }), ctx), "high");
  });

  test("allows a declared reviewed downgrade", async () => {
    const tool = liveTool({
      integration: "mcp",
      action: "call",
      riskTier: "high",
      description: "t",
      inputSchema: z.object({ n: z.number() }),
      resolveRiskTier: async () => "low",
      riskTierDowngradeReason: "reviewed test policy",
      execute: async () => ({ ok: true }),
    });

    assert.equal(await resolveEffectiveRiskTier(bound(tool, { n: 3 }), ctx), "low");
  });
});
