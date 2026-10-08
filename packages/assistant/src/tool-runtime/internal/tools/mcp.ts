/**
 * The fixed MCP tools (PRD #540). A remote tool never becomes a `ToolName`: its
 * `ExternalToolRef` rides in the `mcp.call` args, and dispatch authorizes each call.
 * `mcp.list_tools` and `mcp.inspect_tool` are local catalog reads on the fast path.
 */

import {
  mcpCallInput,
  mcpToolInspectInputSchema,
  mcpToolSearchInputSchema,
  unknownEffectEnvelopeSchema,
} from "@alfred/contracts";
import {
  inspectMcpToolLocal,
  searchMcpToolsLocal,
  type ExternalToolRef,
  type McpCallEnvelope,
} from "@alfred/assistant/connections/mcp";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import {
  getMcpExecutionBroker,
  resolveMcpCallRiskTier,
  type McpBrokerOutcome,
} from "@alfred/assistant/tool-runtime/mcp";

/** Model-safe projection of a broker outcome into an `mcp.call` tool result. */
interface McpBrokerToolResult {
  status: string;
  result?: unknown;
  retry?: "blocked";
  reason?: string;
  message?: string;
}

function brokerResult(outcome: McpBrokerOutcome): McpBrokerToolResult {
  switch (outcome.status) {
    case "completed":
      return withTruncation(
        { status: "completed", result: outcome.envelope.result },
        outcome.envelope,
      );
    case "tool_error":
      // Only idempotent reads reach here. MCP `isError` does not prove no effect occurred.
      return withTruncation(
        { status: "tool_error", result: outcome.envelope.result },
        outcome.envelope,
      );
    case "blocked":
      return {
        status: "blocked",
        retry: "blocked",
        reason: outcome.reason,
        message: outcome.message,
      };
    case "ambiguous":
      // Not a retryable error. The shared schema keeps this and the gate's recognizer in step.
      return unknownEffectEnvelopeSchema.parse({
        status: "unknown",
        retry: "blocked",
        message: outcome.message,
      });
  }
}

function withTruncation<T extends object>(result: T, envelope: McpCallEnvelope): T {
  return envelope.truncation ? { ...result, truncation: envelope.truncation } : result;
}

export const mcpTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "mcp",
    action: "call",
    // An outbound call to an external server always confirms (ADR-0069).
    riskTier: "high",
    description:
      "Invoke a tool on a connected MCP server. Supply the `connectionId`, remote `remoteName`, and `catalogRevision` from the exact ref returned by system.search_tools or mcp.list_tools, plus `arguments` matching the tool schema. Use mcp.inspect_tool if you need the full schema. The call is validated against the server's exact schema and routed through Alfred's approval + durable-execution boundary; a write that may have been delivered but not confirmed comes back as `status:\"unknown\"` and MUST NOT be repeated — check its state instead.",
    discovery: {
      aliases: ["mcp call", "call connected tool", "run mcp tool", "invoke mcp"],
      tags: ["mcp", "integration", "external"],
      entities: ["mcp tool", "connection"],
      verbs: ["call", "invoke", "run", "execute"],
      relatedTools: ["mcp.list_tools"],
    },
    inputSchema: mcpCallInput,
    // Two downgrades: a reviewed policy row on a `readOnlyHint` descriptor (#541),
    // or a read-only resource plus the tool's own `readOnlyHint` (ADR-0096).
    // Reads the persisted catalog only. Any doubt stays high.
    resolveRiskTier: (input, ctx) =>
      resolveMcpCallRiskTier({
        userId: ctx.userId,
        connectionId: input.connectionId,
        remoteName: input.remoteName,
        catalogRevision: input.catalogRevision,
      }),
    riskTierDowngradeReason:
      "#541 reviewed policy binds the exact owned MCP descriptor and catalog revision and lowers only a readOnlyHint tool (ADR-0069 amendment); ADR-0096 grants a read-only built-in endpoint plus a published readOnlyHint",
    execute: async (input, ctx) => {
      if (!ctx.stagingId) {
        // Always staged, so a missing id is a wiring bug.
        throw new Error("mcp.call executed without a staging row id");
      }

      const ref: ExternalToolRef = {
        kind: "mcp",
        connectionId: input.connectionId,
        remoteName: input.remoteName,
        catalogRevision: input.catalogRevision,
      };

      const outcome = await getMcpExecutionBroker().callTool({
        userId: ctx.userId,
        stagingId: ctx.stagingId,
        traceId: ctx.runId,
        ref,
        arguments: input.arguments,
        // The broker copies correlation ids from the staging row, so they cannot drift.
      });

      return brokerResult(outcome);
    },
  }),
  liveTool({
    integration: "mcp",
    action: "list_tools",
    riskTier: "no_risk",
    description:
      "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. `query` matches tool names, titles, and descriptions. Scope with `namespace` or `connectionId`; continue with `cursor`. Use mcp.inspect_tool to inspect a full descriptor. This is a local read.",
    discovery: {
      aliases: ["list mcp tools", "mcp catalog", "what mcp tools", "connected tools"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "connection", "catalog"],
      verbs: ["list", "discover", "browse", "search"],
      relatedTools: ["mcp.call"],
    },
    staging: "fast_path",
    // `mcp` is not `system`, so it keeps the policy gate. This read has no outbound call.
    policyGateWaiver:
      "#540 clarification #5: bounded local read of Alfred's own validated MCP catalog — no outbound action, nothing to approve",
    inputSchema: mcpToolSearchInputSchema,
    execute: (input, ctx) => searchMcpToolsLocal({ userId: ctx.userId, ...input }),
  }),
  liveTool({
    integration: "mcp",
    action: "inspect_tool",
    riskTier: "no_risk",
    description:
      "Inspect one connected MCP tool by the exact ref returned by mcp.list_tools or system.search_tools. Pass only `ref`.",
    discovery: {
      aliases: ["inspect mcp tool", "mcp tool schema"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "descriptor"],
      verbs: ["inspect", "describe"],
      relatedTools: ["mcp.list_tools", "mcp.call"],
    },
    staging: "fast_path",
    policyGateWaiver: "#540: exact local read of Alfred's validated MCP catalog",
    inputSchema: mcpToolInspectInputSchema,
    execute: (input, ctx) => inspectMcpToolLocal({ userId: ctx.userId, ref: input.ref }),
  }),
];
