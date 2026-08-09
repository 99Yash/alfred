import {
  isRecord,
  isToolName,
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import type { ToolSet } from "@alfred/ai";
import { z } from "zod";
import { resolveToolSurface, restoreToolSurface, selectToolPreload } from "@alfred/assistant/tool-runtime";
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
 * The tool surface a run carries in durable state.
 *
 * Every workflow that checkpoints a run holds this same slice, and it is one
 * truth rather than a coincidence: the fields exist to describe *this* module's
 * surface, they are read back through {@link migrateActiveTools} /
 * {@link migrateRecordedToolNames} defined right above, and the #414 preload
 * accounting reads `preloadedTools` + `preloadApplied` together across both
 * workflows. Spread into a run-state schema (`z.object({ ...fields, … })`) so a
 * new field, a changed default, or a new migration lands once here instead of in
 * every workflow that happens to remember.
 *
 * Values are the *persisted* shape (plain `string[]`, tolerant of names retired
 * since the checkpoint was written); {@link foldToolSurfaceState} is what turns
 * them into today's `ToolName[]`, so a schema that spreads these fields must
 * also fold them.
 */
export const toolSurfaceStateFields = {
  // Persisted under an older deploy, so names may refer to tools that have
  // since been retired. The fold drops anything not in today's registry.
  activeTools: z.array(z.string()).optional(),
  // Exact first-turn deterministic selections, persisted so #414 can measure
  // preload hits/misses against the durable transcript. Optional for legacy runs.
  preloadedTools: z.array(z.string()).default([]),
  // Read only while resuming checkpoints created before exact tool surfaces.
  activeIntegrations: z.array(z.string().min(1)).optional(),
  preloadApplied: z.boolean().default(false),
  allowedIntegrations: z.array(z.string()),
};

/** What {@link foldToolSurfaceState} needs from a parsed run state. */
interface ParsedToolSurfaceState {
  activeTools?: string[] | undefined;
  activeIntegrations?: string[] | undefined;
  preloadedTools: string[];
  /** Legacy integration-level checkpoints seed their active surface from these. */
  pendingToolCalls: readonly { toolName: string }[];
}

/**
 * Resolve a parsed {@link toolSurfaceStateFields} slice against today's
 * registry: expand a legacy integration-level checkpoint into exact names, drop
 * retired ones, and discard the now-consumed `activeIntegrations`. Everything
 * else on the state passes through untouched, so a run-state schema's
 * `.transform` is `foldToolSurfaceState(parsed)` plus whatever else that
 * workflow migrates.
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

/** Apply the bounded effect returned by `system.load_tool`; all other output is inert. */
export function applyExactToolLoad(activeTools: readonly ToolName[], result: unknown): ToolName[] {
  if (
    !isRecord(result) ||
    result.ok !== true ||
    typeof result.name !== "string" ||
    !isRegisteredToolName(result.name)
  ) {
    return uniqueToolNames(activeTools);
  }
  return activateTool(activeTools, result.name);
}

function isRegisteredToolName(name: string): name is ToolName {
  return isToolName(name) && restoreToolSurface({ kind: "exact", names: [name] })[0] === name;
}

function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}

/**
 * Project the run's exact active tool names into the SDK `ToolSet` for a model
 * turn, dropping tools the caller could never actually invoke so the model never
 * burns a turn on a call the dispatcher would only bounce:
 *   - `callers` gates boss-only tools (the sub-agent join tools) out of sub-agent
 *     runs (ADR-0073), and
 *   - `requiresLiveChat` gates conversation-bound tools out of background runs.
 * These are the caller-context predicates also used by
 * {@link availableToolNames}. Integration allowlists and credential health are
 * load-time gates: they were checked before a name entered `activeTools` and are
 * intentionally not re-checked at this SDK projection boundary. Thus a kernel
 * tool like `read_chat_history` can be eager in chat yet stay invisible where it
 * can't run. Shared by the chat-turn and brief workflows so the two SDK-tool
 * builders can't drift.
 */
export function buildSdkToolSet(
  activeTools: readonly ToolName[],
  context: ToolRunContext,
): ToolSet {
  return resolveToolSurface({ activeNames: activeTools, context }).tools;
}

/**
 * Build the SDK tool set for one model turn and emit a `runtime.tool_surface`
 * span describing what the model was shown: the active count, the kernel/loaded
 * split, the loaded tool names, and the estimated schema payload (#414). The
 * payload (`schemaBytes`/`schemaTokens`) is the budget signal; the span also
 * carries a `schema_rebuild` band that only registers on a cold rebuild (both
 * the SDK set and the schema estimate are memoized). Prefer this over calling
 * {@link buildSdkToolSet} directly at a turn's model-call site so both workflows
 * measure the surface identically; the underlying set is still memoized, so the
 * only per-turn cost is the (memoized) schema estimate and one best-effort span.
 * Observability never changes the returned set.
 */
function buildTurnToolSurface(args: {
  activeTools: readonly ToolName[];
  context: ToolRunContext;
  runId: string;
  workflow: string;
  /** Span caller label (`boss` | `sub:<id>`); distinct from the availability caller kind. */
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
 * First-turn deterministic preload, folded into the run's active surface and
 * traced as a `runtime.tool.preload` span. Idempotent on `state.preloadApplied`,
 * so it runs at most once per run. Shared by the chat-turn and brief workflows —
 * both open the identical span, rank the latest user prompt, and activate the
 * selected tools — so the selection policy and telemetry can't drift between the
 * two entry points. A thrown ranking/availability error closes the span as an
 * error and propagates (the caller's step-retry owns recovery).
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
  /** Span caller label (`boss` | `sub:<id>`); distinct from the availability caller kind. */
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

/** Bind stable run facts once, then expose the two tool actions a model turn needs. */
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
