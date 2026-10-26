/**
 * Which lazily loaded tools a run never called (#414). Many unused tools means preload is too
 * eager.
 * Kernel tools are always present, so they are left out.
 */

import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { isRecord, isToolName, type ToolName } from "@alfred/contracts";
import { parseStoredTranscript, type TranscriptMessage } from "@alfred/ai";

import { uniqueToolNames } from "@alfred/assistant/tool-runtime";
import { migrateRecordedToolNames, systemToolKernel } from "./tool-surface";

export interface ToolSurfaceUsage {
  /** Non-kernel tools on the final surface. */
  loaded: readonly ToolName[];
  usedLoaded: readonly ToolName[];
  unusedLoaded: readonly ToolName[];
  preloaded: readonly ToolName[];
  usedPreloaded: readonly ToolName[];
  unusedPreloaded: readonly ToolName[];
}

/** Pure. Output is deduplicated and sorted. */
export function summarizeToolSurfaceUsage(args: {
  activeTools: readonly ToolName[];
  preloadedTools: readonly ToolName[];
  kernelTools: ReadonlySet<ToolName>;
  invokedTools: ReadonlySet<ToolName>;
}): ToolSurfaceUsage {
  const loaded = uniqueToolNames(args.activeTools).filter((name) => !args.kernelTools.has(name));

  const preloaded = uniqueToolNames(args.preloadedTools).filter(
    (name) => !args.kernelTools.has(name),
  );

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
 * Tool names from assistant `tool-call` parts. The provider shim already decoded them to dotted
 * form.
 */
export function invokedToolNamesFromTranscript(
  transcript: readonly TranscriptMessage[],
): Set<ToolName> {
  const names = new Set<ToolName>();

  for (const message of transcript) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type === "tool-call" && isToolName(part.toolName)) names.add(part.toolName);
    }
  }

  return names;
}

/**
 * Tool names from one field of raw run state. An old checkpoint can fail the full schema and still
 * hold good names, so read the field alone and migrate renamed tools.
 */
export function toolNamesFromState(
  state: unknown,
  key: "activeTools" | "preloadedTools",
): ToolName[] {
  if (!isRecord(state) || !Array.isArray(state[key])) return [];

  return migrateRecordedToolNames(
    state[key].filter((name): name is string => typeof name === "string"),
  );
}

/** Null when the run does not exist. */
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
    invokedTools: invokedToolNamesFromTranscript(parseStoredTranscript(run.transcript)),
  });
}
