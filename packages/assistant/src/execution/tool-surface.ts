import {
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import type { ToolSet } from "@alfred/ai";
import { z } from "zod";
import {
  callerLabel,
  executeToolCallRound,
  resolveToolSurface,
  restoreToolSurface,
  selectToolPreload,
  type ProposedToolCall,
  type ToolCallActor,
  type ToolCallRoundOutcome,
  type ToolCallRun,
  uniqueToolNames,
} from "@alfred/assistant/tool-runtime";
import { buildConnectedSummaryFromAvailability } from "./connected-summary";
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

/**
 * The run facts that every step of one agent run shares: who calls, for which run, and under which
 * caps. A workflow builds it once from run state; each step passes it to {@link toolRuntimeForRun}.
 */
export type ToolRunIdentity = Omit<ToolCallRun, "stepId" | "fence" | "caller" | "runContext"> &
  ToolCallActor & {
    allowedIntegrations: readonly string[];
  };

type ToolCallRoundInput<Call extends ProposedToolCall> = Parameters<
  typeof executeToolCallRound<Call>
>[0];

/** One dispatch round. The run identity comes from the runtime; the step supplies the rest. */
type ToolRound<Call extends ProposedToolCall> = Omit<ToolCallRoundInput<Call>, "run"> &
  Pick<ToolCallRun, "stepId" | "fence">;

export interface ToolRunTools {
  readonly context: ToolRunContext;
  forModel(activeTools: readonly ToolName[]): ToolSet;
  /** Run one tool round under this run's identity, or return its durable wait. */
  dispatch<Call extends ProposedToolCall>(
    round: ToolRound<Call>,
  ): Promise<ToolCallRoundOutcome<Call>>;
}

/** The model-turn view. It exists only when the step passed the availability snapshot it read. */
export interface ToolTurnTools extends ToolRunTools {
  preload(
    state: {
      activeTools: ToolName[];
      preloadedTools: ToolName[];
      preloadApplied: boolean;
    },
    transcript: readonly { role: string; content: unknown }[],
  ): Promise<void>;
  /**
   * The connected-integration grounding line for the system prompt (ADR-0053). Curated lines come
   * from the snapshot; MCP lines read the owner's connections. The workflow pins it into run state
   * once, because the system prompt hash depends on it.
   */
  connectedSummary(): Promise<string>;
}

/**
 * Bind one step's tool runtime. A model-turn step passes the availability snapshot it read; a
 * dispatch step passes none, so it never reads availability.
 */
export function toolRuntimeForRun(
  identity: ToolRunIdentity,
  availability: IntegrationAvailabilitySnapshot,
): ToolTurnTools;
export function toolRuntimeForRun(identity: ToolRunIdentity): ToolRunTools;
export function toolRuntimeForRun(
  identity: ToolRunIdentity,
  availability?: IntegrationAvailabilitySnapshot,
): ToolRunTools | ToolTurnTools {
  const spanCaller = callerLabel(identity.caller);

  const tools: ToolRunTools = {
    context: identity.runContext,
    forModel: (activeTools) =>
      buildTurnToolSurface({
        activeTools,
        context: identity.runContext,
        runId: identity.runId,
        workflow: identity.workflow,
        spanCaller,
      }),
    dispatch: ({ stepId, fence, ...round }) =>
      executeToolCallRound({ ...round, run: { ...identity, stepId, fence } }),
  };

  if (availability === undefined) return tools;

  return {
    ...tools,
    preload: (state, transcript) =>
      applyPromptToolPreload({
        state,
        allowedIntegrations: identity.allowedIntegrations,
        userId: identity.userId,
        runId: identity.runId,
        workflow: identity.workflow,
        spanCaller,
        transcript,
        context: identity.runContext,
        availability,
      }),
    connectedSummary: () =>
      buildConnectedSummaryFromAvailability(
        identity.userId,
        availability,
        identity.allowedIntegrations,
        identity.runContext,
      ),
  };
}
