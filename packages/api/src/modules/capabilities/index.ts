import type { ToolSet } from "@alfred/ai";
import type { IntegrationAvailabilitySnapshot, ToolName } from "@alfred/contracts";

export interface CapabilitySurfaceContext {
  caller: "boss" | "sub_agent";
  hasThread: boolean;
}

export interface NormalizedCapabilitySurface {
  activeNames: ToolName[];
  kernelNames: ToolName[];
}

export interface ResolvedCapabilitySurface {
  tools: ToolSet;
  surfacedNames: ToolName[];
  kernelCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export interface CapabilityPreloadPlan {
  promptChars: number;
  select(): Promise<ToolName[]>;
}

export interface CapabilitySurfaceAdapter {
  normalize(input: {
    activeNames?: readonly string[] | undefined;
    legacyIntegrationNames?: readonly string[] | undefined;
    pendingNames?: readonly string[] | undefined;
  }): NormalizedCapabilitySurface;
  resolve(input: {
    activeNames: readonly ToolName[];
    context: CapabilitySurfaceContext;
  }): ResolvedCapabilitySurface;
  preparePreload(input: {
    userId: string;
    transcript: readonly { role: string; content: unknown }[];
    allowedIntegrations: readonly string[];
    activeNames: readonly ToolName[];
    context: CapabilitySurfaceContext;
    availability: IntegrationAvailabilitySnapshot;
  }): CapabilityPreloadPlan;
}

let surfaceAdapter: CapabilitySurfaceAdapter | undefined;

/** Runtime composition registers the current tools implementation before workers start. */
export function registerCapabilitySurfaceAdapter(adapter: CapabilitySurfaceAdapter): () => void {
  if (surfaceAdapter && surfaceAdapter !== adapter) {
    throw new Error("A capability surface adapter is already registered");
  }
  surfaceAdapter = adapter;
  return () => {
    if (surfaceAdapter === adapter) surfaceAdapter = undefined;
  };
}

export function normalizeCapabilitySurface(input: {
  activeNames?: readonly string[] | undefined;
  legacyIntegrationNames?: readonly string[] | undefined;
  pendingNames?: readonly string[] | undefined;
}): NormalizedCapabilitySurface {
  return requireSurfaceAdapter().normalize(input);
}

export function resolveCapabilitySurface(input: {
  activeNames: readonly ToolName[];
  context: CapabilitySurfaceContext;
}): ResolvedCapabilitySurface {
  return requireSurfaceAdapter().resolve(input);
}

export function prepareCapabilityPreload(input: {
  userId: string;
  transcript: readonly { role: string; content: unknown }[];
  allowedIntegrations: readonly string[];
  activeNames: readonly ToolName[];
  context: CapabilitySurfaceContext;
  availability: IntegrationAvailabilitySnapshot;
}): CapabilityPreloadPlan {
  return requireSurfaceAdapter().preparePreload(input);
}

function requireSurfaceAdapter(): CapabilitySurfaceAdapter {
  if (!surfaceAdapter) throw new Error("No capability surface adapter is registered");
  return surfaceAdapter;
}
