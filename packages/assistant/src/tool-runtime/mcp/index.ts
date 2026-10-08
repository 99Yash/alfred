/**
 * The MCP tool-runtime door: invocations, the ambiguity barrier, risk, and
 * `resolveMcpToolIdentity` (ADR-0088). Connections live behind
 * `@alfred/assistant/connections/mcp`; imports go only that way.
 * Not re-exported from `tool-runtime/index.ts`, to keep the MCP SDK and vault out of that graph.
 * The `"./tool-runtime/*"` export wildcard still exposes every leaf file.
 * Test-only names live in `./test-support`.
 */

export {
  McpExecutionBroker,
  type McpBrokerBlockReason,
  type McpBrokerCallInput,
  type McpHealthReadInput,
  type McpBrokerOutcome,
  type McpReservedSuccessorInput,
} from "./broker";

export {
  mcpUnresolvedInvocationGate,
  reconcileInflightInvocations,
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type McpToolIdentityUnresolvedReason,
  type OwnedMcpConnectionRef,
  type ReconcileSummary,
} from "./invocations";

export {
  clearMcpToolPolicy,
  readMcpToolPolicyState,
  reviewMcpToolPolicy,
  type McpToolPolicyClearState,
  type McpToolPolicyReviewState,
  type McpToolPolicyState,
} from "./policy";

export {
  clearMcpHealthMapping,
  readMcpHealthMappingState,
  reviewMcpHealthMapping,
  type McpHealthMappingClearState,
  type McpHealthMappingReviewState,
  type McpHealthMappingResolution,
} from "./health-mapping";

export { MCP_CALL_RISK_FLOOR, resolveMcpCallRiskTier } from "./risk";

export { getMcpExecutionBroker } from "./runtime";

export {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
  type McpRecoveryOperationsPageInput,
} from "./recovery";
