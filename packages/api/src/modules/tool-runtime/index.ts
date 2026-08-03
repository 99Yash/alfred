import type { ToolSet } from "@alfred/ai";
import type { IntegrationAvailabilitySnapshot, ToolName } from "@alfred/contracts";

/**
 * Facts about the run that change tool eligibility.
 *
 * `interaction` describes product behavior, not storage or execution location.
 * A live chat can use conversation-bound tools. A background run cannot, even
 * when it reports progress into a chat UI. Remote execution is orthogonal: its
 * validated ingress maps to one of these interaction modes.
 *
 * This value is built from trusted, already-validated run state. Validate
 * persisted, queued, or remote input at its owning boundary, then map it here.
 */
export interface ToolRunContext {
  caller: "boss" | "sub_agent";
  interaction: "live_chat" | "background";
}

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
