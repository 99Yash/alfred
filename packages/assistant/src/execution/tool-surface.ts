import {
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import type { ToolSet } from "@alfred/ai";
import { z } from "zod";
import {
  resolveToolSurface,
  restoreToolSurface,
  selectToolPreload,
} from "@alfred/assistant/tool-runtime";
import { startToolPreloadSpan, startToolSurfaceSpan } from "./runtime-spans";

export function systemToolKernel(): ToolName[] {
  return restoreToolSurface({ kind: "kernel" });
}

/** Expand persisted integration-level state once, then checkpoint exact names. */
export function migrateActiveTools(
  activeTools: readonly string[] | undefined,
  legacyActiveIntegrations: readonly string[] | undefined,
  legacyPendingToolNames: readonly string[] = [],
): ToolName[] {
  return activeTools !== undefined
    ? restoreToolSurface({ kind: "exact", names: activeTools })
    : restoreToolSurface({
        kind: "legacy",
        integrationNames: legacyActiveIntegrations ?? [],
        pendingNames: legacyPendingToolNames,
      });
}

/** Narrow a persisted auxiliary tool-name list without seeding the active kernel. */
export function migrateRecordedToolNames(toolNames: readonly string[]): ToolName[] {
  return restoreToolSurface({ kind: "exact", names: toolNames });
}

/**
 * The tool surface every workflow keeps in run state. Spread it into the state schema,
 * and run {@link foldToolSurfaceState} in the transform: stored names may be retired tools.
 */
export const toolSurfaceStateFields = {
  activeTools: z.array(z.string()).optional(),
  // Kept so #414 can measure preload hits and misses.
  preloadedTools: z.array(z.string()).default([]),
  // Legacy checkpoints only.
  activeIntegrations: z.array(z.string().min(1)).optional(),
  preloadApplied: z.boolean().default(false),
  allowedIntegrations: z.array(z.string()),
};

interface ParsedToolSurfaceState {
  activeTools?: string[] | undefined;
  activeIntegrations?: string[] | undefined;
  preloadedTools: string[];
  /** Legacy integration-level checkpoints seed their active surface from these. */
  pendingToolCalls: readonly { toolName: string }[];
}

/**
 * Expand legacy integration checkpoints, drop retired tool names, and remove `activeIntegrations`.
 */
export function foldToolSurfaceState<T extends ParsedToolSurfaceState>(
  parsed: T,
): Omit<T, "activeTools" | "activeIntegrations" | "preloadedTools"> & {
  activeTools: ToolName[];
  preloadedTools: ToolName[];
} {
  const { activeTools, activeIntegrations, preloadedTools, ...rest } = parsed;

  return {
    ...rest,
    activeTools: migrateActiveTools(
      activeTools,
      activeIntegrations,
      parsed.pendingToolCalls.map((call) => call.toolName),
    ),
    // The kernel is seeded on every surface build, so recording it as a preload
    // would count it as a hit the deterministic selector never made.
    preloadedTools: migrateRecordedToolNames(preloadedTools).filter(
      (name) => !systemToolKernel().includes(name),
    ),
  };
}

export function activateTool(activeTools: readonly ToolName[], toolName: ToolName): ToolName[] {
  return uniqueToolNames([...activeTools, toolName]);
}

/** Deduplicated and sorted, so two surfaces compare by value. */
export function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}

/**
 * Build the SDK `ToolSet`, without tools this caller can never run (boss-only, or live-chat-only).
 * Allowlists and credential health were checked at load time and are not checked again.
 */
export function buildSdkToolSet(
  activeTools: readonly ToolName[],
  context: ToolRunContext,
): ToolSet {
  return resolveToolSurface({ activeNames: activeTools, context }).tools;
}

/**
 * {@link buildSdkToolSet} plus a `runtime.tool_surface` span (#414). The span never changes the
 * set.
 */
function buildTurnToolSurface(args: {
  activeTools: readonly ToolName[];
  context: ToolRunContext;
  runId: string;
  workflow: string;
  /** `boss` or `sub:<id>`; not the availability caller kind. */
  spanCaller: string;
}): ToolSet {
  const startedAt = new Date();
  const startMs = Date.now();

  const surface = resolveToolSurface({
    activeNames: args.activeTools,
    context: args.context,
  });

  const tools = surface.tools;
  startToolSurfaceSpan({
    runId: args.runId,
    workflow: args.workflow,
    caller: args.spanCaller,
    startedAt,
  }).end({
    activeCount: surface.surfacedNames.length,
    kernelCount: surface.kernelCount,
    loadedCount: surface.loadedNames.length,
    loadedTools: surface.loadedNames,
    schemaBytes: surface.schemaBytes,
    schemaTokens: surface.schemaTokens,
    schemaRebuildMs: Date.now() - startMs,
  });

  return tools;
}

/**
 * First-turn preload from the latest user prompt. `state.preloadApplied` makes it run once per run.
 */
async function applyPromptToolPreload(args: {
  state: {
    activeTools: ToolName[];
    preloadedTools: ToolName[];
    preloadApplied: boolean;
  };
  allowedIntegrations: readonly string[];
  userId: string;
  runId: string;
  workflow: string;
  /** `boss` or `sub:<id>`; not the availability caller kind. */
  spanCaller: string;
  transcript: readonly { role: string; content: unknown }[];
  context: ToolRunContext;
  availability: IntegrationAvailabilitySnapshot;
}): Promise<void> {
  if (args.state.preloadApplied) return;

  const span = startToolPreloadSpan({
    runId: args.runId,
    workflow: args.workflow,
    caller: args.spanCaller,
    activeBefore: args.state.activeTools.length,
    allowedIntegrationCount: args.allowedIntegrations.length,
    startedAt: new Date(),
  });

  try {
    const preload = await selectToolPreload({
      userId: args.userId,
      transcript: args.transcript,
      allowedIntegrations: args.allowedIntegrations,
      activeNames: args.state.activeTools,
      context: args.context,
      availability: args.availability,
    });

    const preloaded = preload.selectedNames;

    for (const toolName of preloaded) {
      args.state.activeTools = activateTool(args.state.activeTools, toolName);
    }

    args.state.preloadedTools = uniqueToolNames([...args.state.preloadedTools, ...preloaded]);
    span.end(preloaded, args.state.activeTools.length, preload.promptChars);
  } catch (error) {
    span.error();
    throw error;
  }

  args.state.preloadApplied = true;
}

export interface ToolRunTools {
  readonly context: ToolRunContext;
  preload(
    state: {
      activeTools: ToolName[];
      preloadedTools: ToolName[];
      preloadApplied: boolean;
    },
    transcript: readonly { role: string; content: unknown }[],
  ): Promise<void>;
  forModel(activeTools: readonly ToolName[]): ToolSet;
}

export function toolRuntimeForRun(args: {
  userId: string;
  runId: string;
  workflow: string;
  spanCaller: string;
  context: ToolRunContext;
  allowedIntegrations: readonly string[];
  availability: IntegrationAvailabilitySnapshot;
}): ToolRunTools {
  return {
    context: args.context,
    preload: (state, transcript) =>
      applyPromptToolPreload({
        state,
        allowedIntegrations: args.allowedIntegrations,
        userId: args.userId,
        runId: args.runId,
        workflow: args.workflow,
        spanCaller: args.spanCaller,
        transcript,
        context: args.context,
        availability: args.availability,
      }),
    forModel: (activeTools) =>
      buildTurnToolSurface({
        activeTools,
        context: args.context,
        runId: args.runId,
        workflow: args.workflow,
        spanCaller: args.spanCaller,
      }),
  };
}
