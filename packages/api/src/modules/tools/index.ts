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
  toolRunContext,
  clearToolRegistryForTests,
  type RiskTierCounts,
  type RegisteredTool,
  type LiveToolArgs,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
  type ToolRunContext,
  type ToolAvailabilityResult,
  type ToolUnavailabilityCode,
} from "./registry";
export { latestUserPrompt, preloadToolsForPrompt } from "./discovery";
export { toolExecuteContext } from "./context";
export { toolTiersRoutes } from "./tool-tiers-routes";
