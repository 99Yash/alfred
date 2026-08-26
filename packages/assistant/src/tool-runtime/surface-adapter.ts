import { tool, type Tool, type ToolSet } from "@alfred/ai";
import { isIntegrationSlug, isToolName, type ToolName } from "@alfred/contracts";

import {
  registerToolRuntimeAdapter,
  type ResolvedToolSurface,
  type ToolRuntimeAdapter,
} from "./index";
import { latestUserPrompt, preloadToolsForPrompt } from "./discovery";
import {
  availableToolNames,
  evaluateToolRunContext,
  getTool,
  listKernelTools,
  listRegisteredTools,
  listToolsForIntegration,
  type RegisteredTool,
} from "./internal/registry";
import { estimateToolSurfaceBudget } from "./schema-budget";

const sdkSurfaceCache = new Map<string, ResolvedToolSurface>();

const toolsRuntimeAdapter: ToolRuntimeAdapter = {
  restore(source) {
    switch (source.kind) {
      case "kernel":
        return requiredToolKernelNames();
      case "exact":
        return registeredToolNames(source.names);
      case "legacy": {
        const integrationNames = new Set<ToolName>();
        for (const integration of source.integrationNames) {
          if (integration === "system" || !isIntegrationSlug(integration)) continue;
          for (const definition of listToolsForIntegration(integration)) {
            integrationNames.add(definition.name);
          }
        }
        return uniqueToolNames([
          ...requiredToolKernelNames(),
          ...integrationNames,
          ...registeredToolNames(source.pendingNames),
        ]);
      }
    }
  },

  /**
   * Memoized per (caller, interaction, active-name-set). The registry is
   * write-once after boot, so the projection is safe to share across turns and
   * users. The registry is small, so the process-lifetime cache stays bounded
   * in practice by the small number of distinct active sets.
   */
  resolve(input) {
    const activeNames = uniqueToolNames(input.activeNames);
    // ToolName is a dotted identifier and cannot contain a comma, so this join is collision-free.
    const key = `${input.context.caller}:${input.context.interaction}:${activeNames.join(",")}`;
    const cached = sdkSurfaceCache.get(key);
    if (cached) return cached;

    const definitions: RegisteredTool[] = [];
    const tools: Partial<Record<ToolName, Tool>> = {};
    for (const name of activeNames) {
      const definition = getTool(name);
      if (!definition || !evaluateToolRunContext(definition, input.context).available) continue;
      definitions.push(definition);
      tools[name] = tool({
        description: definition.description,
        inputSchema: definition.inputSchema,
      });
    }

    const budget = estimateToolSurfaceBudget(definitions);
    const surfacedNames = definitions.map((definition) => definition.name);
    const loadedNames = definitions
      .filter((definition) => definition.availability?.surface !== "kernel")
      .map((definition) => definition.name);
    const resolved: ResolvedToolSurface = {
      // SAFETY: the SDK ToolSet is an index-signature record of tools; the
      // resolved tool map satisfies it by construction.
      tools: tools as ToolSet,
      surfacedNames,
      loadedNames,
      kernelCount: surfacedNames.length - loadedNames.length,
      schemaBytes: budget.schemaBytes,
      schemaTokens: budget.schemaTokens,
    };
    sdkSurfaceCache.set(key, resolved);
    return resolved;
  },

  namesForIntegrations(integrations) {
    const names = new Set<ToolName>();
    for (const integration of integrations) {
      if (!isIntegrationSlug(integration)) continue;
      for (const definition of listToolsForIntegration(integration)) {
        names.add(definition.name);
      }
    }
    return uniqueToolNames([...names]);
  },

  availableToolNamesByIntegration(input) {
    const registeredTools = listRegisteredTools();
    const available = availableToolNames(
      input.availability,
      registeredTools,
      input.allowedIntegrations,
      input.context,
    );
    const grouped = new Map<string, ToolName[]>();
    for (const tool of registeredTools) {
      if (!available.has(tool.name)) continue;
      const names = grouped.get(tool.integration);
      if (names) names.push(tool.name);
      else grouped.set(tool.integration, [tool.name]);
    }
    for (const names of grouped.values()) names.sort();
    return grouped;
  },

  async selectPreload(input) {
    const prompt = latestUserPrompt(input.transcript);
    return {
      promptChars: prompt.length,
      selectedNames: await preloadToolsForPrompt({
        userId: input.userId,
        prompt,
        allowedIntegrations: input.allowedIntegrations,
        activeTools: input.activeNames,
        context: input.context,
        availability: input.availability,
      }),
    };
  },
};

export function registerToolsRuntimeAdapter(): void {
  registerToolRuntimeAdapter(toolsRuntimeAdapter);
}

/** Test-only: clear projections whose keys assume the production write-once registry. */
export function clearToolRuntimeCacheForTests(): void {
  sdkSurfaceCache.clear();
}

function requiredToolKernelNames(): ToolName[] {
  const kernel = listKernelTools();
  if (kernel.length === 0) {
    throw new Error("No system tools are registered for the kernel surface");
  }
  return kernel.map((definition) => definition.name);
}

function registeredToolNames(names: readonly string[]): ToolName[] {
  return uniqueToolNames(
    names.filter((name): name is ToolName => isToolName(name) && getTool(name) !== undefined),
  );
}

function uniqueToolNames(names: readonly ToolName[]): ToolName[] {
  return [...new Set(names)].sort();
}
