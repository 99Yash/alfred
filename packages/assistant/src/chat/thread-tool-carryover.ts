import {
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, desc, ne } from "drizzle-orm";
import { z } from "zod";
import {
  activateTool,
  migrateRecordedToolNames,
  toolSurfaceStateFields,
} from "@alfred/assistant/execution";
import { availableToolNamesByIntegration } from "@alfred/assistant/tool-runtime";
import { chatThreadRunsWhere } from "./chat-thread-runs";

// The previous run's persisted surface, read through the field that owns it.
// Narrow on purpose: a checkpoint written under an older deploy may fail the
// full chat run-state schema for unrelated reasons and still carry good names.
const carriedSurfaceSchema = z.object({ activeTools: toolSurfaceStateFields.activeTools });

/**
 * Seed a new chat run's tool surface from the previous run on the same thread.
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
 * context — the same gate `system.load_tool` applies — so a tool whose
 * integration disconnected since the last turn is dropped here rather than
 * bouncing at dispatch. Names retired since the checkpoint fall out in
 * `migrateRecordedToolNames`. Reads the latest run on the thread regardless of
 * how it ended: a failed turn's loaded tools are as good a prior as a completed
 * one's, and this run itself is excluded so a step retry is idempotent.
 */
export async function carryForwardThreadTools(args: {
  userId: string;
  threadId: string;
  runId: string;
  workflowSlug: string;
  activeTools: readonly ToolName[];
  allowedIntegrations: readonly string[];
  availability: IntegrationAvailabilitySnapshot;
  context: ToolRunContext;
}): Promise<{ activeTools: ToolName[]; carried: ToolName[] }> {
  const rows = await db()
    .select({ state: agentRuns.state })
    .from(agentRuns)
    .where(and(chatThreadRunsWhere(args), ne(agentRuns.id, args.runId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const persisted = carriedSurfaceSchema.safeParse(rows[0]?.state);
  if (!persisted.success || !persisted.data.activeTools) {
    return { activeTools: [...args.activeTools], carried: [] };
  }

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
  const carried = migrateRecordedToolNames(persisted.data.activeTools).filter(
    (name) => loadable.has(name) && !already.has(name),
  );
  let activeTools: ToolName[] = [...args.activeTools];
  for (const name of carried) activeTools = activateTool(activeTools, name);
  return { activeTools, carried };
}
