import { isIntegrationSlug, isRecord, isToolName, type ToolName } from "@alfred/contracts";
import { z } from "zod";
import { getTool, listKernelTools, listToolsForIntegration } from "../tools/registry";

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
  const kernel = listKernelTools();
  if (kernel.length === 0) {
    throw new Error("No system tools are registered for the kernel surface");
  }
  return kernel.map((tool) => tool.name);
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

/**
 * Fold a completed system tool call's run-state effect into the active surface.
 * Only `system.load_tool` mutates it — a successful load adds one exact tool for
 * the next model turn; every other system tool is inert here. The result is
 * treated as untrusted and validated by {@link applyExactToolLoad}, so the
 * dispatch envelope is typed structurally rather than coupling this module to
 * the dispatcher. Shared by the chat-turn and brief workflows so the two paths
 * can't drift.
 */
export function applySystemToolEffect(
  state: { activeTools: ToolName[] },
  toolName: string,
  result: { readonly kind: string; readonly toolResult?: unknown },
): void {
  if (toolName === "system.load_tool" && result.kind === "executed") {
    state.activeTools = applyExactToolLoad(state.activeTools, result.toolResult);
  }
}

function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}
