import { isIntegrationSlug, isRecord, isToolName, type ToolName } from "@alfred/contracts";
import { z } from "zod";
import {
  assertKernelToolsRegistered,
  getTool,
  listKernelTools,
  listToolsForIntegration,
} from "../tools/registry";

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
  assertKernelToolsRegistered();
  return listKernelTools().map((tool) => tool.name);
}

/** Expand persisted integration-level state once, then checkpoint exact names. */
export function migrateActiveTools(
  activeTools: readonly string[] | undefined,
  legacyActiveIntegrations: readonly string[] | undefined,
  legacyPendingToolNames: readonly string[] = [],
): ToolName[] {
  if (activeTools) return uniqueToolNames(registeredToolNames(activeTools));
  const pendingTools = registeredToolNames(legacyPendingToolNames);
  return uniqueToolNames([
    ...systemToolKernel(),
    ...registeredToolNamesForIntegrations(legacyActiveIntegrations ?? []),
    ...pendingTools,
  ]);
}

function registeredToolNames(toolNames: readonly string[]): ToolName[] {
  return toolNames.filter(
    (name): name is ToolName => isToolName(name) && getTool(name) !== undefined,
  );
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
