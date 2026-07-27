import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { z } from "zod";

import {
  resolveToolAvailability,
  type IntegrationAvailabilitySnapshot,
} from "../../src/modules/integrations/availability";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
} from "../../src/modules/tools/registry";

afterEach(() => {
  clearToolRegistryForTests();
});

function tool(args: {
  action: "read_scratch" | "web_search";
  staging?: "fast_path" | "join";
  riskTier?: "no_risk" | "high";
  dynamicRisk?: boolean;
  policyGateWaiver?: string;
}) {
  return liveTool({
    integration: "system",
    action: args.action,
    riskTier: args.riskTier ?? "no_risk",
    description: "test tool",
    ...(args.staging ? { staging: args.staging } : {}),
    ...(args.dynamicRisk ? { resolveRiskTier: async () => "high" as const } : {}),
    ...(args.policyGateWaiver ? { policyGateWaiver: args.policyGateWaiver } : {}),
    inputSchema: z.object({}).loose(),
    execute: async () => ({ ok: true }),
  });
}

/** A non-`system` tool, i.e. one whose policy mode comes from the user's policy. */
function notionTool(args: { staging?: "fast_path"; policyGateWaiver?: string }) {
  return liveTool({
    integration: "notion",
    action: "append_blocks",
    riskTier: "medium",
    description: "test notion write",
    ...(args.staging ? { staging: args.staging } : {}),
    ...(args.policyGateWaiver ? { policyGateWaiver: args.policyGateWaiver } : {}),
    inputSchema: z.object({}).loose(),
    execute: async () => ({ ok: true }),
  });
}

function joinTool(args: {
  inputSchema: z.ZodTypeAny;
  action?: "await_sub_agent" | "spawn_sub_agent";
}) {
  return liveTool({
    integration: "system",
    action: args.action ?? "await_sub_agent",
    riskTier: "no_risk",
    description: "test join tool",
    staging: "join",
    inputSchema: args.inputSchema,
    execute: async () => ({ ok: true }),
  });
}

describe("the staging policy is declared, and defaults to staged", () => {
  test("an omitted policy resolves to `staged`", () => {
    assert.equal(tool({ action: "web_search" }).staging, "staged");
  });

  test("a declared policy survives the registry boundary", () => {
    assert.equal(tool({ action: "read_scratch", staging: "fast_path" }).staging, "fast_path");
    assert.equal(tool({ action: "read_scratch", staging: "join" }).staging, "join");
  });
});

describe("the fast path may not waive an approval a tool could require", () => {
  test("registering a high-tier fast-path tool throws at boot", () => {
    assert.throws(
      () => registerTool(tool({ action: "web_search", staging: "fast_path", riskTier: "high" })),
      /staging='fast_path'.*riskTier='high'/s,
    );
  });

  test("registering a fast-path tool with a dynamic risk tier throws at boot", () => {
    assert.throws(
      () => registerTool(tool({ action: "web_search", staging: "fast_path", dynamicRisk: true })),
      /resolveRiskTier/,
    );
  });

  test("a no-risk fast-path tool registers", () => {
    assert.doesNotThrow(() => registerTool(tool({ action: "read_scratch", staging: "fast_path" })));
  });

  test("a high-tier tool on the default staged path registers", () => {
    assert.doesNotThrow(() => registerTool(tool({ action: "web_search", riskTier: "high" })));
  });

  // The half a riskTier-only guard misses: approval is
  // `policyMode === "gated" || riskTier === "high"`, and only `system` is forced
  // to autonomy at the floor. So a low-tier NON-system fast path skips a real
  // approval under the default policy — the naive call must fail at boot.
  test("a mid-tier non-system fast-path tool throws without a named waiver", () => {
    assert.throws(
      () => registerTool(notionTool({ staging: "fast_path" })),
      /only 'system' is forced to autonomy/,
    );
  });

  test("a non-system fast-path tool registers once the waiver names the reason", () => {
    assert.doesNotThrow(() =>
      registerTool(notionTool({ staging: "fast_path", policyGateWaiver: "local read, #540 #5" })),
    );
  });

  test("a waiver without the fast path throws — nothing waives that tool's gate", () => {
    assert.throws(
      () => registerTool(notionTool({ policyGateWaiver: "local read" })),
      /does not declare staging='fast_path'/,
    );
  });
});

describe("`join` is a protocol, and registration proves the declarer speaks it", () => {
  test("a join tool whose schema lacks childRunId throws at boot", () => {
    assert.throws(
      () => registerTool(joinTool({ inputSchema: z.object({ runId: z.string() }) })),
      /does not accept.*childRunId/s,
    );
  });

  test("a join tool that accepts childRunId registers", () => {
    assert.doesNotThrow(() =>
      registerTool(joinTool({ inputSchema: z.object({ childRunId: z.string().min(1) }) })),
    );
  });

  test("a second join declarer throws — the arm has one implementation", () => {
    registerTool(joinTool({ inputSchema: z.object({ childRunId: z.string().min(1) }) }));
    assert.throws(
      () =>
        registerTool(
          joinTool({
            action: "spawn_sub_agent",
            inputSchema: z.object({ childRunId: z.string().min(1) }),
          }),
        ),
      /already does/,
    );
  });
});

describe("resolveToolAvailability reads the credential snapshot only when it could matter", () => {
  const exploding = () =>
    Promise.reject(new Error("loadSnapshot must not be called for this tool"));

  test("a `system.*` tool resolves from the registration with no snapshot read", async () => {
    const result = await resolveToolAvailability({
      tool: tool({ action: "web_search" }),
      allowed: new Set(),
      context: { caller: "boss", hasThread: true },
      loadSnapshot: exploding,
    });
    assert.deepEqual(result, { available: true });
  });

  test("an `mcp.*` tool resolves with no snapshot read", async () => {
    // `mcp` is deliberately not a loadable slug: its connection health lives on
    // `mcp_connections`, not `integration_credentials`, so it is absent from the
    // snapshot. Reading the snapshot for it would resolve every MCP tool to
    // `not_connected` and silently kill the whole MCP surface.
    const mcpListTools = liveTool({
      integration: "mcp",
      action: "list_tools",
      riskTier: "no_risk",
      description: "test mcp list_tools",
      staging: "fast_path",
      inputSchema: z.object({}).loose(),
      execute: async () => ({ ok: true }),
    });

    const result = await resolveToolAvailability({
      tool: mcpListTools,
      allowed: new Set(),
      context: { caller: "boss", hasThread: true },
      loadSnapshot: exploding,
    });
    assert.deepEqual(result, { available: true });
  });

  test("a context-gate refusal short-circuits before any snapshot read", async () => {
    const gmailSearch = liveTool({
      integration: "gmail",
      action: "search",
      riskTier: "no_risk",
      description: "test gmail search",
      availability: { callers: ["boss"] },
      inputSchema: z.object({}).loose(),
      execute: async () => ({ ok: true }),
    });

    const result = await resolveToolAvailability({
      tool: gmailSearch,
      allowed: new Set(),
      context: { caller: "sub_agent", hasThread: true },
      loadSnapshot: exploding,
    });
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "wrong_caller");
  });

  test("a credential-bearing tool DOES read the snapshot, and honors its health", async () => {
    const gmailSearch = liveTool({
      integration: "gmail",
      action: "search",
      riskTier: "no_risk",
      description: "test gmail search",
      inputSchema: z.object({}).loose(),
      execute: async () => ({ ok: true }),
    });
    let reads = 0;
    const snapshot: IntegrationAvailabilitySnapshot = {
      integrations: new Map([["gmail", { health: "needs_reauth", accountLabel: null }]]),
      providers: new Map(),
      passthroughEnabled: new Map(),
    };

    const result = await resolveToolAvailability({
      tool: gmailSearch,
      allowed: new Set(),
      context: { caller: "boss", hasThread: true },
      loadSnapshot: async () => {
        reads += 1;
        return snapshot;
      },
    });

    assert.equal(reads, 1);
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "needs_reauth");
  });
});
