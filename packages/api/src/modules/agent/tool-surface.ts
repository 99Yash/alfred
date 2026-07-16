import { isIntegrationSlug, isRecord, isToolName, type ToolName } from "@alfred/contracts";
import { tool, type Tool, type ToolSet } from "@alfred/ai";
import { z } from "zod";
import {
  getTool,
  listKernelTools,
  listToolsForIntegration,
  type RegisteredTool,
} from "../tools/registry";
import type {
  ToolAvailabilityContext,
  IntegrationAvailabilitySnapshot,
} from "../integrations/availability";
import { latestUserPrompt, preloadToolsForPrompt } from "../tools/discovery";
import type { DispatchResult } from "../dispatch";
import { startToolPreloadSpan, startToolSurfaceSpan } from "./runtime-spans";
import { estimateToolSurfaceBudget } from "./schema-budget";

export const toolNameSchema = z.custom<ToolName>(
  (value) => typeof value === "string" && isToolName(value),
  "Invalid tool name",
);

export function registeredToolNamesForIntegrations(integrations: readonly string[]): ToolName[] {
  const names = new Set<ToolName>();
  for (const integration of integrations) {
    if (!isIntegrationSlug(integration)) continue;
    for (const registered of listToolsForIntegration(integration)) names.add(registered.name);
  }
  return [...names].sort();
}

export function systemToolKernel(): ToolName[] {
  const kernel = listKernelTools();
  if (kernel.length === 0) {
    throw new Error("No system tools are registered for the kernel surface");
  }
  return kernel.map((tool) => tool.name);
}

/** Expand persisted integration-level state once, then checkpoint exact names. */
export function migrateActiveTools(
  activeTools: readonly string[] | undefined,
  legacyActiveIntegrations: readonly string[] | undefined,
  legacyPendingToolNames: readonly string[] = [],
): ToolName[] {
  if (activeTools) return migrateRecordedToolNames(activeTools);
  const pendingTools = registeredToolNames(legacyPendingToolNames);
  return uniqueToolNames([
    ...systemToolKernel(),
    ...registeredToolNamesForIntegrations(
      (legacyActiveIntegrations ?? []).filter((integration) => integration !== "system"),
    ),
    ...pendingTools,
  ]);
}

/** Narrow a persisted auxiliary tool-name list without seeding the active kernel. */
export function migrateRecordedToolNames(toolNames: readonly string[]): ToolName[] {
  return uniqueToolNames(registeredToolNames(toolNames));
}

function registeredToolNames(toolNames: readonly string[]): ToolName[] {
  return toolNames.filter(
    (name): name is ToolName => isToolName(name) && getTool(name) !== undefined,
  );
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
    !isToolName(result.name) ||
    getTool(result.name) === undefined
  ) {
    return uniqueToolNames(activeTools);
  }
  return activateTool(activeTools, result.name);
}

/**
 * Fold a completed system tool call's run-state effect into the active surface.
 * Only `system.load_tool` mutates it — a successful load adds one exact tool for
 * the next model turn; every other system tool is inert here. The result is
 * treated as untrusted and validated by {@link applyExactToolLoad}. The
 * type-only dispatcher import preserves the real result discriminant without
 * adding a runtime dependency. Shared by the chat-turn and brief workflows so
 * the two paths can't drift.
 */
export function applySystemToolEffect(
  state: { activeTools: ToolName[] },
  toolName: string,
  result: Pick<DispatchResult, "kind"> & { readonly toolResult?: unknown },
): void {
  if (toolName === "system.load_tool" && result.kind === "executed") {
    state.activeTools = applyExactToolLoad(state.activeTools, result.toolResult);
  }
}

function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].sort();
}

/**
 * Memoized SDK `ToolSet` per (caller, hasThread, active-name-set). The registry
 * is write-once at boot, so a tool's SDK definition is a pure function of its
 * name; the returned object is treated as read-only by the SDK, so sharing one
 * instance across turns and users is safe. Keyed by the availability context too
 * because that changes which tools are exposed. Unbounded but bounded in
 * practice — the registry is small and the distinct active-set count is tiny.
 */
const sdkToolSetCache = new Map<string, ToolSet>();

/**
 * Project the run's exact active tool names into the SDK `ToolSet` for a model
 * turn, dropping tools the caller could never actually invoke so the model never
 * burns a turn on a call the dispatcher would only bounce:
 *   - `callers` gates boss-only tools (the sub-agent join tools) out of sub-agent
 *     runs (ADR-0073), and
 *   - `requiresThread` gates thread-only tools (chat history) out of thread-less
 *     brief/sub-agent runs.
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
  context: ToolAvailabilityContext,
): ToolSet {
  const names = [...new Set(activeTools)].sort();
  const key = `${context.caller}:${context.hasThread}:${names.join(",")}`;
  const cached = sdkToolSetCache.get(key);
  if (cached) return cached;

  const out: Partial<Record<ToolName, Tool>> = {};
  for (const name of names) {
    const registered = getTool(name);
    if (!registered) continue;
    const availability = registered.availability;
    if (availability?.callers && !availability.callers.includes(context.caller)) continue;
    if (availability?.requiresThread && !context.hasThread) continue;
    out[registered.name] = tool({
      description: registered.description,
      inputSchema: registered.inputSchema,
    });
  }
  const tools = out as ToolSet;
  sdkToolSetCache.set(key, tools);
  return tools;
}

/**
 * Build the SDK tool set for one model turn and emit a `runtime.tool_surface`
 * span describing what the model was shown: the active count, the kernel/loaded
 * split, the loaded tool names, and the estimated schema payload (#414). The
 * span is judged against the `schema_build` debug band so an over-budget or
 * slow-to-build surface is filterable. Prefer this over calling
 * {@link buildSdkToolSet} directly at a turn's model-call site so both workflows
 * measure the surface identically; the underlying set is still memoized, so the
 * only per-turn cost is the (memoized) schema estimate and one best-effort span.
 * Observability never changes the returned set.
 */
export function buildTurnToolSurface(args: {
  activeTools: readonly ToolName[];
  context: ToolAvailabilityContext;
  runId: string;
  workflow: string;
  /** Span caller label (`boss` | `sub:<id>`); distinct from the availability caller kind. */
  spanCaller: string;
}): ToolSet {
  const startedAt = new Date();
  const startMs = Date.now();
  const tools = buildSdkToolSet(args.activeTools, args.context);
  const surfaced: RegisteredTool[] = [];
  for (const name of Object.keys(tools)) {
    if (!isToolName(name)) continue;
    const registered = getTool(name);
    if (registered) surfaced.push(registered);
  }
  const budget = estimateToolSurfaceBudget(surfaced);
  const kernel: ToolName[] = [];
  const loaded: ToolName[] = [];
  for (const tool of surfaced) {
    if (tool.availability?.surface === "kernel") kernel.push(tool.name);
    else loaded.push(tool.name);
  }
  startToolSurfaceSpan({
    runId: args.runId,
    workflow: args.workflow,
    caller: args.spanCaller,
    startedAt,
  }).end({
    activeCount: surfaced.length,
    kernelCount: kernel.length,
    loadedCount: loaded.length,
    loadedTools: loaded,
    schemaBytes: budget.schemaBytes,
    schemaTokens: budget.schemaTokens,
    schemaBuildMs: Date.now() - startMs,
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
export async function applyPromptToolPreload(args: {
  state: {
    activeTools: ToolName[];
    preloadedTools: ToolName[];
    allowedIntegrations: string[];
    preloadApplied: boolean;
  };
  userId: string;
  runId: string;
  workflow: string;
  /** Span caller label (`boss` | `sub:<id>`); distinct from the availability caller kind. */
  spanCaller: string;
  transcript: readonly { role: string; content: unknown }[];
  context: ToolAvailabilityContext;
  availability: IntegrationAvailabilitySnapshot;
}): Promise<void> {
  if (args.state.preloadApplied) return;
  const prompt = latestUserPrompt(args.transcript);
  const span = startToolPreloadSpan({
    runId: args.runId,
    workflow: args.workflow,
    caller: args.spanCaller,
    activeBefore: args.state.activeTools.length,
    allowedIntegrationCount: args.state.allowedIntegrations.length,
    promptChars: prompt.length,
    startedAt: new Date(),
  });
  try {
    const preloaded = await preloadToolsForPrompt({
      userId: args.userId,
      prompt,
      allowedIntegrations: args.state.allowedIntegrations,
      activeTools: args.state.activeTools,
      context: args.context,
      availability: args.availability,
    });
    for (const toolName of preloaded) {
      args.state.activeTools = activateTool(args.state.activeTools, toolName);
    }
    args.state.preloadedTools = uniqueToolNames([...args.state.preloadedTools, ...preloaded]);
    span.end(preloaded, args.state.activeTools.length);
  } catch (error) {
    span.error();
    throw error;
  }
  args.state.preloadApplied = true;
}
