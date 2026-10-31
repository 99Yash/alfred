import { tool, type Tool } from "@alfred/ai";
import { assertNever, isIntegrationSlug, isToolName, type ToolName } from "@alfred/contracts";

import {
  registerToolRuntimeAdapter,
  type ResolvedToolSurface,
  type ToolRuntimeAdapter,
  uniqueToolNames,
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
      case "legacy":
        // A legacy checkpoint restores only the system kernel, not every system tool (#412,
        // ADR-0053 amendment); `namesForIntegrations` includes them on purpose.
        return uniqueToolNames([
          ...requiredToolKernelNames(),
          ...integrationToolNames(
            source.integrationNames.filter((integration) => integration !== "system"),
          ),
          ...registeredToolNames(source.pendingNames),
        ]);
      default:
        return assertNever(source, "tool surface source");
    }
  },

  /** Memoized per caller, interaction, and active-name set. Safe because the registry is write-once. */
  resolve(input) {
    const activeNames = uniqueToolNames(input.activeNames);
    // A ToolName cannot contain a comma, so the join cannot collide.
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
        // Model-facing. See `LiveToolArgs.modelInputSchema`.
        inputSchema: definition.modelInputSchema,
      });
    }

    const budget = estimateToolSurfaceBudget(definitions);
    const surfacedNames = definitions.map((definition) => definition.name);

    const loadedNames = definitions
      .filter((definition) => definition.availability?.surface !== "kernel")
      .map((definition) => definition.name);

    const resolved: ResolvedToolSurface = {
      tools,
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
    return integrationToolNames(integrations);
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

/** Test-only: the cache keys assume a write-once registry. */
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

/** Every registered tool of each known integration slug; unknown slugs contribute nothing. */
function integrationToolNames(integrations: readonly string[]): ToolName[] {
  return uniqueToolNames(
    integrations
      .filter(isIntegrationSlug)
      .flatMap((integration) => listToolsForIntegration(integration).map((tool) => tool.name)),
  );
}
