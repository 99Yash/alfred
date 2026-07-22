/**
 * The two projected MCP tools (PRD #540). The open-ended external catalog never
 * widens the closed `ToolName`: a fixed `mcp.call` / `mcp.list_tools` pair carries
 * the `ExternalToolRef` (connection + remote name + catalog revision) in its ARGS,
 * and every call is authorized independently at Alfred's dispatch boundary.
 *
 *  - `mcp.call` is a static `high`-tier action: it ALWAYS stages for approval
 *    (the risk floor in `toolRequiresApproval`), then routes through the durable
 *    execution broker, which owns the ambiguity ledger. A future reviewed
 *    per-descriptor policy may downgrade the effective tier; until then the
 *    conservative floor holds.
 *  - `mcp.list_tools` is a bounded LOCAL read of the persisted catalog. It runs on
 *    the dispatcher's fast path (no staging, no approval, no ledger) because it
 *    performs no outbound action — see the `mcp.list_tools` intercept in
 *    `dispatchToolCall`.
 */

import { mcpCallInput, mcpListToolsInput } from "@alfred/contracts";
import {
  getMcpExecutionBroker,
  listMcpToolsLocal,
  type ExternalToolRef,
  type McpBrokerOutcome,
  type McpCallEnvelope,
} from "../mcp";
import { liveTool, type RegisteredTool } from "./registry";

/** Model-safe projection of a broker outcome into an `mcp.call` tool result. */
function brokerResult(outcome: McpBrokerOutcome): unknown {
  switch (outcome.status) {
    case "completed":
      return withTruncation(
        { status: "completed", result: outcome.envelope.result },
        outcome.envelope,
      );
    case "tool_error":
      // The remote server received the call and returned a tool-level error. It is
      // a definitive rejection (no effect), distinct from an ambiguous write.
      return withTruncation({ status: "tool_error", result: outcome.envelope.result }, outcome.envelope);
    case "blocked":
      return { status: "blocked", retry: "blocked", reason: outcome.reason, message: outcome.message };
    case "ambiguous":
      // The doc's normative unknown-outcome envelope: explicit, and NOT an ordinary
      // retryable error the model should self-correct on.
      return { status: "unknown", retry: "blocked", message: outcome.message };
  }
}

function withTruncation(
  result: Record<string, unknown>,
  envelope: McpCallEnvelope,
): Record<string, unknown> {
  return envelope.truncation ? { ...result, truncation: envelope.truncation } : result;
}

export const mcpTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "mcp",
    action: "call",
    // Static high floor: an MCP call is an outbound action against an external
    // server, so it always confirms regardless of policy (ADR-0069 floor).
    riskTier: "high",
    description:
      "Invoke a tool on a connected MCP server. Supply the `connectionId`, the remote `remoteName`, the `catalogRevision` you selected the tool under (from mcp.list_tools), and the tool's `arguments` as a JSON object matching that tool's schema. The call is validated against the server's exact schema and routed through Alfred's approval + durable-execution boundary; a write that may have been delivered but not confirmed comes back as `status:\"unknown\"` and MUST NOT be repeated — check its state instead.",
    discovery: {
      aliases: ["mcp call", "call connected tool", "run mcp tool", "invoke mcp"],
      tags: ["mcp", "integration", "external"],
      entities: ["mcp tool", "connection"],
      verbs: ["call", "invoke", "run", "execute"],
      relatedTools: ["mcp.list_tools"],
    },
    inputSchema: mcpCallInput,
    execute: async (input, ctx) => {
      if (!ctx.stagingId) {
        // mcp.call is always staged (high floor), so it only reaches execution via
        // the staged/approved path, which threads the staging row id. A missing id
        // is a wiring bug, not a runtime condition — fail loud.
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
        ref,
        arguments: input.arguments,
        // Correlation (trace/step/tool-call) is NOT threaded from ctx: the broker's
        // persistence layer copies it from the authorizing staging row at mint, so
        // the ledger's breadcrumbs cannot drift from the row they describe (#541).
      });
      return brokerResult(outcome);
    },
  }),
  liveTool({
    integration: "mcp",
    action: "list_tools",
    riskTier: "no_risk",
    description:
      "List the tools available on a connected MCP server. Returns compact summaries (name, title, short description) for the connection's current catalog, filtered by an optional `query` and paginated with `limit`/`cursor`. Pass `remoteName` to get the one tool's full descriptor (including its argument schema) before calling it. This is a local read of Alfred's validated catalog — it never dumps the whole catalog and never hits the network.",
    discovery: {
      aliases: ["list mcp tools", "mcp catalog", "what mcp tools", "connected tools"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "connection", "catalog"],
      verbs: ["list", "discover", "browse", "search"],
      relatedTools: ["mcp.call"],
    },
    inputSchema: mcpListToolsInput,
    execute: async (input, ctx) => listMcpToolsLocal(input, ctx.userId),
  }),
];
