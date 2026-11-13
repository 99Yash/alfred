/**
 * The fixed MCP tools (PRD #540). A remote tool never becomes a `ToolName`: its
 * `ExternalToolRef` rides in the `mcp.call` args, and dispatch authorizes each call.
 * `mcp.list_tools` and `mcp.inspect_tool` are local catalog reads on the fast path.
 */

import {
  assertNever,
  mcpCallInput,
  mcpToolInspectInputSchema,
  mcpToolSearchInputSchema,
  unknownEffectEnvelopeSchema,
} from "@alfred/contracts";
import { AppError, publicAppError } from "@alfred/contracts/app-errors";
import {
  inspectMcpToolLocal,
  McpClientError,
  mcpScopeAdmits,
  mcpServerIdsAdmittedBy,
  needsMcpReauthorization,
  readOwnedConnection,
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
  /**
   * `false` when the remote tool failed or nothing was sent. `executedResultOutcome` reads it, so
   * the action record, the trace span, and the chat trail all show the call as failed. `tool_error`
   * and `blocked` are not failure statuses for every tool: a `system.*_workflow` draft is `blocked`
   * and `ok`. A `blocked` result keeps `retry: "blocked"`, because an earlier attempt may have
   * landed (`leavesEffectUnconfirmed`).
   */
  ok?: false;
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
        { ok: false, status: "tool_error", result: outcome.envelope.result },
        outcome.envelope,
      );
    case "blocked":
      return {
        ok: false,
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
    default:
      return assertNever(outcome, "MCP broker outcome");
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
    replay: "safe",
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
    // Before the staging row, so a call outside the run's integrations gets no approval card.
    // Only a fresh proposal runs this. The broker checks the connection that runs again.
    refuseProposal: async (input, ctx) => {
      const serverIds = await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations);

      if (serverIds === null) return null;

      const connection = await readOwnedConnection(input.connectionId, ctx.userId);

      // An unknown connection fails in the broker with its own error.
      if (!connection || mcpScopeAdmits(serverIds, connection.serverId)) return null;

      return publicAppError("mcp_connection_outside_scope").message;
    },
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

      let outcome: McpBrokerOutcome;

      try {
        outcome = await getMcpExecutionBroker().callTool({
          userId: ctx.userId,
          stagingId: ctx.stagingId,
          traceId: ctx.runId,
          ref,
          arguments: input.arguments,
          // `input` is the effective input (an approval edit included), on a resume and a replay too.
          serverScope: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
          // The broker copies correlation ids from the staging row, so they cannot drift.
        });
      } catch (error) {
        // Only errors that escape the broker reach here; ambiguous outcomes keep their barrier.
        if (needsMcpReauthorization(error)) {
          throw new AppError("mcp_reauth_required", { cause: error });
        }

        // A generic "try again" makes the model resend the same call, so these name the next step.
        if (error instanceof McpClientError) {
          // The broker already published the live catalog, so a new search returns a current ref.
          if (error.code === "catalog_stale") {
            throw new AppError("mcp_catalog_stale", { cause: error });
          }

          if (error.code === "arguments_rejected") {
            throw new AppError("mcp_arguments_rejected", { cause: error });
          }

          if (error.code === "outside_scope") {
            throw new AppError("mcp_connection_outside_scope", { cause: error });
          }
        }

        throw error;
      }

      return brokerResult(outcome);
    },
  }),
  liveTool({
    integration: "mcp",
    action: "list_tools",
    riskTier: "no_risk",
    replay: "safe",
    description:
      'Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. `query` matches tool names, titles, and descriptions: every word must match, and a word that names the connection ("railway" for Railway) is skipped. Scope with `namespace` or `connectionId`; continue with `cursor`. Use mcp.inspect_tool to inspect a full descriptor. This is a local read.',
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
    execute: async (input, ctx) =>
      searchMcpToolsLocal({
        userId: ctx.userId,
        serverIds: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
        ...input,
      }),
  }),
  liveTool({
    integration: "mcp",
    action: "inspect_tool",
    riskTier: "no_risk",
    replay: "safe",
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
    execute: async (input, ctx) =>
      inspectMcpToolLocal({
        userId: ctx.userId,
        ref: input.ref,
        serverIds: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
      }),
  }),
];
