import {
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, chatThreadRunMatch } from "@alfred/db/schemas";
import { and, desc, ne } from "drizzle-orm";
import { toolNamesFromState, uniqueToolNames } from "@alfred/assistant/execution";
import { availableToolNamesByIntegration } from "@alfred/assistant/tool-runtime";

/**
 * More than one: a run that failed early saved a kernel-only surface. Carry-over
 * chains, so older runs add nothing.
 */
const THREAD_TOOL_CARRYOVER_LOOKBACK = 3;

/**
 * Seed a run's tools from the thread's last turn. The preload ranks only the latest
 * message, so a short follow-up would reload the same tools step by step.
 * Each name is gated again by `availableToolNamesByIntegration`, so a disconnected tool drops here.
 */
export async function carryForwardThreadTools(args: {
  userId: string;
  threadId: string;
  runId: string;
  activeTools: readonly ToolName[];
  allowedIntegrations: readonly string[];
  availability: IntegrationAvailabilitySnapshot;
  context: ToolRunContext;
}): Promise<{ activeTools: ToolName[]; carried: ToolName[] }> {
  const rows = await db()
    .select({ state: agentRuns.state })
    .from(agentRuns)
    .where(and(chatThreadRunMatch(agentRuns, args), ne(agentRuns.id, args.runId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(THREAD_TOOL_CARRYOVER_LOOKBACK);

  const loadable = new Set(
    [
      ...availableToolNamesByIntegration({
        availability: args.availability,
        allowedIntegrations: args.allowedIntegrations,
        context: args.context,
      }).values(),
    ].flat(),
  );

  const already = new Set(args.activeTools);

  for (const row of rows) {
    const carried = toolNamesFromState(row.state, "activeTools").filter(
      (name) => loadable.has(name) && !already.has(name),
    );

    if (carried.length === 0) continue;

    return { activeTools: uniqueToolNames([...args.activeTools, ...carried]), carried };
  }

  return { activeTools: [...args.activeTools], carried: [] };
}
