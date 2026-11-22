import { tool, type Tool } from "@alfred/ai";
import {
  assertNever,
  CODE_RUN_TOOL,
  isIntegrationSlug,
  isToolName,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";

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
import { codeRunDescription } from "./code-mode/index-text";
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

  /**
   * Memoized per run context and active-name set. Safe because the registry is write-once.
   */
  resolve(input) {
    const activeNames = uniqueToolNames(input.activeNames);

    // `satisfies`: a new `ToolRunContext` field fails to compile until this object holds it.
    // The key serializes the object itself, so each field in the object is in the key.
    const context = {
      caller: input.context.caller,
      interaction: input.context.interaction,
      readPath: input.context.readPath ?? "direct",
    } satisfies Record<keyof ToolRunContext, string>;

    const codeRunIndex = input.codeRunIndex ?? null;
    const key = JSON.stringify([context, activeNames, codeRunIndex]);
    const cached = sdkSurfaceCache.get(key);

    if (cached) return cached;

    const definitions: RegisteredTool[] = [];
    const tools: Partial<Record<ToolName, Tool>> = {};

    for (const name of activeNames) {
      const definition = getTool(name);

      if (!definition || !evaluateToolRunContext(definition, input.context).available) continue;
      definitions.push(definition);
      tools[name] = tool({
        description:
          name === CODE_RUN_TOOL && codeRunIndex !== null
            ? pinnedCodeRunDescription(codeRunIndex)
            : definition.description,
        // Model-facing. See `LiveToolArgs.modelInputSchema`.
        inputSchema: definition.modelInputSchema,
      });
    }

    const budget = estimateToolSurfaceBudget(
      definitions.map((definition) =>
        definition.name === CODE_RUN_TOOL && codeRunIndex !== null
          ? { ...definition, description: pinnedCodeRunDescription(codeRunIndex) }
          : definition,
      ),
    );

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
  pinnedCodeRunDescriptions.clear();
}

/** Keyed by the joined paths. Safe for the same reason as `sdkSurfaceCache`. */
const pinnedCodeRunDescriptions = new Map<string, string>();

/** The `system.code_run` description whose index lists only the run's pinned paths. */
function pinnedCodeRunDescription(paths: readonly string[]): string {
  const key = paths.join("\n");
  const cached = pinnedCodeRunDescriptions.get(key);

  if (cached !== undefined) return cached;

  const readTools = listRegisteredTools().filter((definition) => definition.codeModeRead);
  const description = codeRunDescription(readTools, new Set(paths));
  pinnedCodeRunDescriptions.set(key, description);

  return description;
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
