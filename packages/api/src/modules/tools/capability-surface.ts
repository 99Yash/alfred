import { tool, type Tool, type ToolSet } from "@alfred/ai";
import { isIntegrationSlug, isToolName, type ToolName } from "@alfred/contracts";

import {
  registerCapabilitySurfaceAdapter,
  type CapabilitySurfaceAdapter,
  type CapabilitySurfaceContext,
  type ResolvedCapabilitySurface,
} from "../capabilities";
import { latestUserPrompt, preloadToolsForPrompt } from "./discovery";
import { getTool, listKernelTools, listToolsForIntegration, type RegisteredTool } from "./registry";
import { estimateCapabilitySurfaceBudget } from "./schema-budget";

const sdkSurfaceCache = new Map<string, ResolvedCapabilitySurface>();

const toolCapabilitySurfaceAdapter: CapabilitySurfaceAdapter = {
  normalize(input) {
    if (input.activeNames) {
      return {
        activeNames: registeredCapabilityNames(input.activeNames),
        kernelNames: listKernelTools().map((definition) => definition.name),
      };
    }

    const kernelNames = requiredCapabilityKernelNames();
    const integrationNames = new Set<ToolName>();
    for (const integration of input.legacyIntegrationNames ?? []) {
      if (integration === "system" || !isIntegrationSlug(integration)) continue;
      for (const definition of listToolsForIntegration(integration)) {
        integrationNames.add(definition.name);
      }
    }
    return {
      activeNames: uniqueCapabilityNames([
        ...kernelNames,
        ...integrationNames,
        ...registeredCapabilityNames(input.pendingNames ?? []),
      ]),
      kernelNames,
    };
  },

  resolve(input) {
    const activeNames = uniqueCapabilityNames(input.activeNames);
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

    const budget = estimateCapabilitySurfaceBudget(definitions);
    const surfacedNames = definitions.map((definition) => definition.name);
    const loadedNames = definitions
      .filter((definition) => definition.availability?.surface !== "kernel")
      .map((definition) => definition.name);
    const resolved: ResolvedCapabilitySurface = {
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
    return uniqueCapabilityNames([...names]);
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

export function registerToolCapabilitySurfaceAdapter(): void {
  registerCapabilitySurfaceAdapter(toolCapabilitySurfaceAdapter);
}

/** Test-only: clear projections whose keys assume the production write-once registry. */
export function clearToolCapabilitySurfaceCacheForTests(): void {
  sdkSurfaceCache.clear();
}

function requiredCapabilityKernelNames(): ToolName[] {
  const kernel = listKernelTools();
  if (kernel.length === 0) {
    throw new Error("No system tools are registered for the kernel surface");
  }
  return kernel.map((definition) => definition.name);
}

function registeredCapabilityNames(names: readonly string[]): ToolName[] {
  return uniqueCapabilityNames(
    names.filter((name): name is ToolName => isToolName(name) && getTool(name) !== undefined),
  );
}

function uniqueCapabilityNames(names: readonly ToolName[]): ToolName[] {
  return [...new Set(names)].sort();
}

function availableToCaller(definition: RegisteredTool, context: CapabilitySurfaceContext): boolean {
  const availability = definition.availability;
  if (availability?.callers && !availability.callers.includes(context.caller)) return false;
  return !availability?.requiresThread || context.hasThread;
}
