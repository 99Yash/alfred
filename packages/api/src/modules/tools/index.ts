/** Side-effect-free tools interface for registry and availability operations. */

export {
  liveTool,
  registerTool,
  registerTools,
  getTool,
  listKernelTools,
  listRegisteredTools,
  listToolsForIntegration,
  availableToolNames,
  evaluateToolAvailability,
  evaluateToolRunContext,
  evaluateToolCatalog,
  readsAvailabilitySnapshot,
  resolveToolAvailability,
  riskTierCountsForIntegration,
  clearToolRegistryForTests,
  type RiskTierCounts,
  type RegisteredTool,
  type LiveToolArgs,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
  type ToolAvailabilityResult,
  type ToolUnavailabilityCode,
} from "./registry";
export type { ToolRunContext } from "@alfred/contracts";
export { latestUserPrompt, preloadToolsForPrompt } from "./discovery";
export { toolExecuteContext } from "./context";
export { toolTiersRoutes } from "./tool-tiers-routes";
