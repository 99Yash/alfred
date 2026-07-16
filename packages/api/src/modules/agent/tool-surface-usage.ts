/**
 * Loaded-but-unused tool accounting (#414, PRD #405, User Story 16).
 *
 * The `runtime.tool_surface` span records what the model was *shown*; this
 * answers the complementary question an operator needs to tune preload — of the
 * lazily loaded tools on the run's final surface, which were never actually
 * called? A high unused count means the deterministic preloader (or the model's
 * own search/load) is warming schemas the turn didn't need, the exact
 * over-eager-heuristic signal the PRD wants queryable.
 *
 * Split, like `run-bottlenecks`, into a pure aggregator (`summarizeToolSurfaceUsage`)
 * a test drives with synthetic sets, and a thin DB wrapper
 * (`getRunToolSurfaceUsage`) that reads the already-persisted sources: the run's
 * final `state.activeTools` (the loaded surface), `state.preloadedTools` (the
 * deterministic selections), and its transcript (the tools actually invoked).
 * Kernel tools are excluded — they are always present, so "unused kernel" is
 * not a preload signal.
 */

import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import {
  isRecord,
  isToolName,
  type AgentTranscriptMessage,
  type ToolName,
} from "@alfred/contracts";

import { systemToolKernel } from "./tool-surface";

export interface ToolSurfaceUsage {
  /** Lazily loaded (non-kernel) tools on the run's final active surface. */
  loaded: readonly ToolName[];
  /** Loaded tools the run invoked at least once. */
  usedLoaded: readonly ToolName[];
  /** Loaded tools never invoked — the over-eager-preload signal. */
  unusedLoaded: readonly ToolName[];
  /** Exact tools selected by the deterministic first-turn preloader. */
  preloaded: readonly ToolName[];
  /** Preloaded tools invoked at least once — preload hits. */
  usedPreloaded: readonly ToolName[];
  /** Preloaded tools never invoked — preload misses. */
  unusedPreloaded: readonly ToolName[];
}

/**
 * Fold a run's loaded surface against the tools it invoked. Pure — the caller
 * supplies all three sets. `loaded` is the non-kernel slice of the active
 * surface; `usedLoaded`/`unusedLoaded` partition it by invocation. Deduped and
 * sorted so the result is stable regardless of input order or repeats.
 */
export function summarizeToolSurfaceUsage(args: {
  activeTools: readonly ToolName[];
  preloadedTools: readonly ToolName[];
  kernelTools: ReadonlySet<ToolName>;
  invokedTools: ReadonlySet<ToolName>;
}): ToolSurfaceUsage {
  const loaded = [...new Set(args.activeTools)]
    .filter((name) => !args.kernelTools.has(name))
    .sort();
  const preloaded = [...new Set(args.preloadedTools)]
    .filter((name) => !args.kernelTools.has(name))
    .sort();
  return {
    loaded,
    usedLoaded: loaded.filter((name) => args.invokedTools.has(name)),
    unusedLoaded: loaded.filter((name) => !args.invokedTools.has(name)),
    preloaded,
    usedPreloaded: preloaded.filter((name) => args.invokedTools.has(name)),
    unusedPreloaded: preloaded.filter((name) => !args.invokedTools.has(name)),
  };
}

/**
 * Every tool the transcript shows the model actually calling. Reads dotted
 * canonical names straight off assistant `tool-call` parts — the provider shim
 * decodes `__`→`.` before anything is persisted, so the transcript already holds
 * the `ToolName` form. Content is untyped, so each part is narrowed before use.
 */
export function invokedToolNamesFromTranscript(
  transcript: readonly AgentTranscriptMessage[],
): Set<ToolName> {
  const names = new Set<ToolName>();
  for (const message of transcript) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-call") continue;
      const toolName = part.toolName;
      if (typeof toolName === "string" && isToolName(toolName)) names.add(toolName);
    }
  }
  return names;
}

/** Untyped `state.activeTools` narrowed to registered-name-shaped strings. */
function toolNamesFromState(state: unknown, key: "activeTools" | "preloadedTools"): ToolName[] {
  if (!isRecord(state) || !Array.isArray(state[key])) return [];
  return state[key].filter(
    (name): name is ToolName => typeof name === "string" && isToolName(name),
  );
}

/**
 * Read one run's loaded-but-unused accounting from Postgres. Returns null when
 * the run row doesn't exist. Thin by design — all logic lives in the pure
 * aggregator and extractor above.
 */
export async function getRunToolSurfaceUsage(runId: string): Promise<ToolSurfaceUsage | null> {
  const rows = await db()
    .select({ state: agentRuns.state, transcript: agentRuns.transcript })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) return null;

  return summarizeToolSurfaceUsage({
    activeTools: toolNamesFromState(run.state, "activeTools"),
    preloadedTools: toolNamesFromState(run.state, "preloadedTools"),
    kernelTools: new Set(systemToolKernel()),
    invokedTools: invokedToolNamesFromTranscript(run.transcript),
  });
}
