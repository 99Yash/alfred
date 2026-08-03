import type { ToolSet } from "@alfred/ai";
import type { IntegrationAvailabilitySnapshot, ToolName, ToolRunContext } from "@alfred/contracts";

export interface NormalizedToolSurface {
  activeNames: ToolName[];
  kernelNames: ToolName[];
}

export interface ResolvedToolSurface {
  tools: ToolSet;
  surfacedNames: ToolName[];
  loadedNames: ToolName[];
  kernelCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export interface ToolPreloadPlan {
  /**
   * Prompt extraction is synchronous so the workflow can attach its size to
   * the span before timing the asynchronous selection. Keep `select` deferred:
   * the workflow owns that span and must record selection failures on it.
   */
  promptChars: number;
  select(): Promise<ToolName[]>;
}

export interface ToolRuntimeAdapter {
  normalize(input: {
    activeNames?: readonly string[] | undefined;
    legacyIntegrationNames?: readonly string[] | undefined;
    pendingNames?: readonly string[] | undefined;
  }): NormalizedToolSurface;
  resolve(input: {
    activeNames: readonly ToolName[];
    context: ToolRunContext;
  }): ResolvedToolSurface;
  namesForIntegrations(integrations: readonly string[]): ToolName[];
  preparePreload(input: {
    userId: string;
    transcript: readonly { role: string; content: unknown }[];
    allowedIntegrations: readonly string[];
    activeNames: readonly ToolName[];
    context: ToolRunContext;
    availability: IntegrationAvailabilitySnapshot;
  }): ToolPreloadPlan;
}

let toolRuntimeAdapter: ToolRuntimeAdapter | undefined;

/** Runtime composition registers the current tools implementation before workers start. */
export function registerToolRuntimeAdapter(adapter: ToolRuntimeAdapter): () => void {
  if (toolRuntimeAdapter && toolRuntimeAdapter !== adapter) {
    throw new Error("A tool runtime adapter is already registered");
  }
  toolRuntimeAdapter = adapter;
  return () => {
    if (toolRuntimeAdapter === adapter) toolRuntimeAdapter = undefined;
  };
}

export function normalizeToolSurface(input: {
  activeNames?: readonly string[] | undefined;
  legacyIntegrationNames?: readonly string[] | undefined;
  pendingNames?: readonly string[] | undefined;
}): NormalizedToolSurface {
  return requireToolRuntimeAdapter().normalize(input);
}

/**
 * Project names that already passed load-time allowlist and credential gates.
 * Tool-runtime registration is part of worker boot; calling before boot fails.
 */
export function resolveToolSurface(input: {
  activeNames: readonly ToolName[];
  context: ToolRunContext;
}): ResolvedToolSurface {
  return requireToolRuntimeAdapter().resolve(input);
}

export function toolNamesForIntegrations(integrations: readonly string[]): ToolName[] {
  return requireToolRuntimeAdapter().namesForIntegrations(integrations);
}

export function prepareToolPreload(input: {
  userId: string;
  transcript: readonly { role: string; content: unknown }[];
  allowedIntegrations: readonly string[];
  activeNames: readonly ToolName[];
  context: ToolRunContext;
  availability: IntegrationAvailabilitySnapshot;
}): ToolPreloadPlan {
  return requireToolRuntimeAdapter().preparePreload(input);
}

function requireToolRuntimeAdapter(): ToolRuntimeAdapter {
  if (!toolRuntimeAdapter) throw new Error("No tool runtime adapter is registered");
  return toolRuntimeAdapter;
}
