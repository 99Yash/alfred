import type { ToolSet } from "@alfred/ai";
import type { IntegrationAvailabilitySnapshot, ToolName, ToolRunContext } from "@alfred/contracts";

export type ToolSurfaceSource =
  | { kind: "kernel" }
  | { kind: "exact"; names: readonly string[] }
  | {
      kind: "legacy";
      integrationNames: readonly string[];
      pendingNames: readonly string[];
    };

export interface ResolvedToolSurface {
  tools: ToolSet;
  surfacedNames: ToolName[];
  loadedNames: ToolName[];
  kernelCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export interface SelectedToolPreload {
  promptChars: number;
  selectedNames: ToolName[];
}

export interface ToolRuntimeAdapter {
  restore(source: ToolSurfaceSource): ToolName[];
  resolve(input: {
    activeNames: readonly ToolName[];
    context: ToolRunContext;
  }): ResolvedToolSurface;
  namesForIntegrations(integrations: readonly string[]): ToolName[];
  selectPreload(input: {
    userId: string;
    transcript: readonly { role: string; content: unknown }[];
    allowedIntegrations: readonly string[];
    activeNames: readonly ToolName[];
    context: ToolRunContext;
    availability: IntegrationAvailabilitySnapshot;
  }): Promise<SelectedToolPreload>;
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

/** Restore one explicit persisted-surface shape against today's tool catalog. */
export function restoreToolSurface(source: ToolSurfaceSource): ToolName[] {
  return requireToolRuntimeAdapter().restore(source);
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

export function selectToolPreload(input: {
  userId: string;
  transcript: readonly { role: string; content: unknown }[];
  allowedIntegrations: readonly string[];
  activeNames: readonly ToolName[];
  context: ToolRunContext;
  availability: IntegrationAvailabilitySnapshot;
}): Promise<SelectedToolPreload> {
  return requireToolRuntimeAdapter().selectPreload(input);
}

function requireToolRuntimeAdapter(): ToolRuntimeAdapter {
  if (!toolRuntimeAdapter) throw new Error("No tool runtime adapter is registered");
  return toolRuntimeAdapter;
}
