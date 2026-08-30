/**
 * The MCP tool-runtime door: durable invocation, the ambiguity barrier, result
 * correlation, the reviewed-downgrade risk resolver, and the one identity
 * derivation (`resolveMcpToolIdentity`) that ADR-0088 makes the single fail-closed
 * owner of `(current catalog revision, descriptor hash, reviewed policy)`.
 *
 * What lives behind this door is a tool call, not a connection. The live client,
 * the session cache, and the connection rows are behind
 * `@alfred/assistant/connections/mcp`; this module imports that one and never the
 * other way round.
 *
 * This barrel is deliberately NOT re-exported from `tool-runtime/index.ts`. That
 * barrel is imported nearly everywhere, and folding the MCP client SDK plus the
 * credential vault into its graph is exactly the door-widening this split exists
 * to avoid.
 *
 * Enforcement tier 4, not 1. The package manifest already carries
 * `"./tool-runtime/*": "./src/tool-runtime/*.ts"`, so
 * `@alfred/assistant/tool-runtime/mcp/invocations` resolves whether or not this
 * file names it, and the private-import fence is blind to a bare specifier. Item
 * 79 owns narrowing that wildcard and is the only thing that promotes this door.
 *
 * Names a test wants and production does not are behind `./test-support`, the same
 * way `action-policies` does it — `upsertToolPolicy`, the reviewed-downgrade mint,
 * and `_setMcpExecutionBrokerForTests`, which replaces the singleton below it, are
 * there rather than here. The rule holds for both singleton setters or for
 * neither: its twin `_setMcpConnectionManagerForTests` is behind
 * `@alfred/assistant/connections/mcp/test-support`.
 */

export {
  McpExecutionBroker,
  type McpBrokerBlockReason,
  type McpBrokerCallInput,
  type McpBrokerOutcome,
  type McpReservedSuccessorInput,
} from "./broker";
export {
  reconcileInflightInvocations,
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type OwnedMcpConnectionRef,
  type ReconcileSummary,
} from "./invocations";
export { MCP_CALL_RISK_FLOOR, resolveMcpCallRiskTier } from "./risk";
export { getMcpExecutionBroker } from "./runtime";
export {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
} from "./recovery";
