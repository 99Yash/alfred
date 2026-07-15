import { isIntegrationSlug, isRecord, isToolName, type ToolName } from "@alfred/contracts";
import { z } from "zod";
import { getTool, listToolsForIntegration } from "../tools/registry";

const SYSTEM_TOOL_KERNEL = [
  "system.current_time",
  "system.load_tool",
  "system.search_tools",
] as const satisfies readonly ToolName[];

export const toolNameSchema = z.custom<ToolName>(
  (value) => typeof value === "string" && isToolName(value),
  "Invalid tool name",
);

export function registeredToolNamesForIntegrations(integrations: readonly string[]): ToolName[] {
  const names = new Set<ToolName>();
  for (const integration of integrations) {
    if (!isIntegrationSlug(integration)) continue;
    for (const registered of listToolsForIntegration(integration)) names.add(registered.name);
  }
  return [...names].sort();
}

export function systemToolKernel(): ToolName[] {
  return SYSTEM_TOOL_KERNEL.filter((name) => getTool(name) !== undefined);
}

/** Expand persisted integration-level state once, then checkpoint exact names. */
export function migrateActiveTools(
  activeTools: readonly ToolName[] | undefined,
  legacyActiveIntegrations: readonly string[] | undefined,
  legacyPendingToolNames: readonly string[] = [],
): ToolName[] {
  if (activeTools) return uniqueToolNames(activeTools);
  const pendingTools = legacyPendingToolNames.filter(
    (name): name is ToolName => isToolName(name) && getTool(name) !== undefined,
  );
  return uniqueToolNames([
    ...systemToolKernel(),
    ...registeredToolNamesForIntegrations(legacyActiveIntegrations ?? []),
    ...pendingTools,
  ]);
}

export function activateTool(activeTools: readonly ToolName[], toolName: ToolName): ToolName[] {
  return uniqueToolNames([...activeTools, toolName]);
}

/** Apply the bounded effect returned by `system.load_tool`; all other output is inert. */
export function applyExactToolLoad(activeTools: readonly ToolName[], result: unknown): ToolName[] {
  if (
    !isRecord(result) ||
    result.ok !== true ||
    typeof result.name !== "string" ||
    !isToolName(result.name) ||
    getTool(result.name) === undefined
  ) {
    return uniqueToolNames(activeTools);
  }
  return activateTool(activeTools, result.name);
}

function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}
