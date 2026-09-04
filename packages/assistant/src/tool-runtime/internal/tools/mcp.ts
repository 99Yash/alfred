/**
 * The two projected MCP tools (PRD #540). The open-ended external catalog never
 * widens the closed `ToolName`: a fixed `mcp.call` / `mcp.list_tools` pair carries
 * the `ExternalToolRef` (connection + remote name + catalog revision) in its ARGS,
 * and every call is authorized independently at Alfred's dispatch boundary.
 *
 *  - `mcp.call` carries a static `high` FLOOR: an unreviewed MCP tool always
 *    stages for approval (the risk floor in `toolRequiresApproval`), then routes
 *    through the durable execution broker, which owns the ambiguity ledger. A
 *    `resolveRiskTier` hook narrows that floor at the dispatch gate when the user
 *    has reviewed the exact descriptor and recorded a lower tier in
 *    `mcp_tool_policy` (#541 Part 3) — drift or an unreviewed tool re-gates high.
 *  - `mcp.list_tools` is a bounded LOCAL read of the persisted catalog. It runs on
 *    the dispatcher's fast path (no staging, no approval, no ledger) because it
 *    performs no outbound action — see the `mcp.list_tools` intercept in
 *    `dispatchToolCall`.
 */

import { mcpCallInput, mcpListToolsInput, unknownEffectEnvelopeSchema } from "@alfred/contracts";
import {
  listMcpToolsLocal,
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
/** Model-safe projection of a broker outcome. `unknown`-free by construction. */
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
      // Only idempotent reads can reach this arm. Effectful tool errors remain
      // ambiguous because MCP `isError` does not prove that no effect occurred.
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
      // The doc's normative unknown-outcome envelope: explicit, and NOT an ordinary
      // retryable error the model should self-correct on. Produced through the shared
      // schema so the dispatch gate's recognizer and this producer stay one shape.
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
    // Two downgrade authorities over the `high` floor above. The REVIEWED one
    // (#541) narrows it when the user has reviewed the exact descriptor the model
    // selected and recorded a tier. The STRUCTURAL one (ADR-0096) narrows it for a
    // tool that is a read on two independent proofs: its connection's endpoint is
    // a built-in read-only protected resource, and its own published descriptor
    // asserted `annotations.readOnlyHint`. All resolution reads Alfred's PERSISTED
    // catalog (no live client at the gate); any uncertainty — unowned connection,
    // stale revision, descriptor drift, a corrupt policy row — stays high.
    resolveRiskTier: (input, ctx) =>
      resolveMcpCallRiskTier({
        userId: ctx.userId,
        connectionId: input.connectionId,
        remoteName: input.remoteName,
        catalogRevision: input.catalogRevision,
      }),
    riskTierDowngradeReason:
      "#541 reviewed policy binds the exact owned MCP descriptor and catalog revision; ADR-0096 grants a read-only built-in endpoint plus a published readOnlyHint",
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
        traceId: ctx.runId,
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
      'Search the tools in all of your connected MCP catalogs without first knowing a connection. Returns compact hits with an exact `ref`, namespace, and connection identity. `query` matches tool names, titles, and descriptions only; scope to one connection with `namespace` or `connectionId`. Continue bounded scans with `cursor`. Pass `detail:"names"` to omit prose. To inspect one full descriptor, pass ONLY a previously returned `ref` and no other field: search fields and `ref` are exclusive, and a request that mixes them is rejected. This is a local read of Alfred\'s validated catalogs and never hits the network.',
    discovery: {
      aliases: ["list mcp tools", "mcp catalog", "what mcp tools", "connected tools"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "connection", "catalog"],
      verbs: ["list", "discover", "browse", "search"],
      relatedTools: ["mcp.call"],
    },
    // A bounded LOCAL read of Alfred's already-validated MCP catalog (#540
    // clarification #5) — no outbound action, so it needs no staging row and
    // nothing to approve, exactly like a scratch read. `mcp.call` gets no such
    // bypass: it is a high-tier action that always stages, then routes through
    // the durable broker on execute.
    staging: "fast_path",
    // `mcp` is deliberately NOT `system` (see contracts/src/tools.ts) precisely
    // so it keeps the per-user policy gate — and the fast path is what removes
    // that gate, so the waiver has to be explicit rather than implied by the
    // comment above. Safe here because there is no outbound call to approve: the
    // read is of rows Alfred itself wrote and validated. It does NOT generalize
    // to another `mcp` tool.
    policyGateWaiver:
      "#540 clarification #5: bounded local read of Alfred's own validated MCP catalog — no outbound action, nothing to approve",
    inputSchema: mcpListToolsInput,
    execute: (input, ctx) => listMcpToolsLocal({ userId: ctx.userId, request: input }),
  }),
];
