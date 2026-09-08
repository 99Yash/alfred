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
 * How many of the thread's previous runs the carry-over looks back through for
 * a surface worth inheriting. The latest run alone is not enough: a run that
 * failed before its own carry-over ran, or one written before this feature,
 * persisted a kernel-only surface and would shadow the useful one behind it.
 * Because carry-over chains (each run's surface includes what it inherited),
 * anything older than a few runs holds nothing the newer ones lack.
 */
const THREAD_TOOL_CARRYOVER_LOOKBACK = 3;

/**
 * Seed a new chat run's tool surface from the thread's previous runs.
 *
 * Every run starts from the system kernel, and the deterministic preload ranks
 * only the latest user message — so a short follow-up ("apply to all") on a
 * thread whose previous turn already loaded `gmail.search` and
 * `system.remember` paid two model steps per tool to load them again (prod
 * `run_tsevusjk1poq`: six of its twenty-four steps). A thread is one
 * conversation; the tools its last turn needed are the best prior for the
 * next, so carry them over instead of rediscovering them.
 *
 * Re-gated, not trusted: a carried name enters `activeTools` only if it is
 * loadable right now under this run's allowlist, credential health, and caller
 * context — `availableToolNamesByIntegration`, the same evaluator behind
 * `system.load_tool` — so a tool whose integration disconnected since the last
 * turn is dropped here rather than bouncing at dispatch. Names retired since the
 * checkpoint fall out in `toolNamesFromState`. Reads the thread's latest runs
 * regardless of how they ended (a failed turn's loaded tools are as good a prior
 * as a completed one's), takes the newest that carries anything, and excludes
 * this run itself so a step retry is idempotent.
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
