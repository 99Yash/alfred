import { tool, type Tool, type ToolSet } from "@alfred/ai";
import { isIntegrationSlug, isToolName, type ToolName } from "@alfred/contracts";

import {
  registerToolRuntimeAdapter,
  type ResolvedToolSurface,
  type ToolRuntimeAdapter,
  type ToolSurfaceContext,
} from "../tool-runtime";
import { latestUserPrompt, preloadToolsForPrompt } from "./discovery";
import { getTool, listKernelTools, listToolsForIntegration, type RegisteredTool } from "./registry";
import { estimateToolSurfaceBudget } from "./schema-budget";

const sdkSurfaceCache = new Map<string, ResolvedToolSurface>();

const toolsRuntimeAdapter: ToolRuntimeAdapter = {
  normalize(input) {
    if (input.activeNames) {
      return {
        activeNames: registeredToolNames(input.activeNames),
        kernelNames: listKernelTools().map((definition) => definition.name),
      };
    }

    const kernelNames = requiredToolKernelNames();
    const integrationNames = new Set<ToolName>();
    for (const integration of input.legacyIntegrationNames ?? []) {
      if (integration === "system" || !isIntegrationSlug(integration)) continue;
      for (const definition of listToolsForIntegration(integration)) {
        integrationNames.add(definition.name);
      }
    }
    return {
      activeNames: uniqueToolNames([
        ...kernelNames,
        ...integrationNames,
        ...registeredToolNames(input.pendingNames ?? []),
      ]),
      kernelNames,
    };
  },

  resolve(input) {
    const activeNames = uniqueToolNames(input.activeNames);
    const key = `${input.context.caller}:${input.context.hasThread}:${activeNames.join(",")}`;
    const cached = sdkSurfaceCache.get(key);
    if (cached) return cached;

    const definitions: RegisteredTool[] = [];
    const tools: Partial<Record<ToolName, Tool>> = {};
    for (const name of activeNames) {
      const definition = getTool(name);
      if (!definition || !availableToCaller(definition, input.context)) continue;
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

  preparePreload(input) {
    const prompt = latestUserPrompt(input.transcript);
    return {
      promptChars: prompt.length,
      select: () =>
        preloadToolsForPrompt({
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

function availableToCaller(definition: RegisteredTool, context: ToolSurfaceContext): boolean {
  const availability = definition.availability;
  if (availability?.callers && !availability.callers.includes(context.caller)) return false;
  return !availability?.requiresThread || context.hasThread;
}
