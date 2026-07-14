import { isIntegrationSlug, isToolName, type ToolName } from "@alfred/contracts";
import { z } from "zod";
import { getTool, listToolsForIntegration } from "../tools/registry";

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
  return registeredToolNamesForIntegrations(["system"]);
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
    ...registeredToolNamesForIntegrations(["system", ...(legacyActiveIntegrations ?? [])]),
    ...pendingTools,
  ]);
}

export function activateTool(activeTools: readonly ToolName[], toolName: ToolName): ToolName[] {
  return uniqueToolNames([...activeTools, toolName]);
}

function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}
