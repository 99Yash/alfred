import { agentRuns } from "@alfred/db/schemas";
import { and, eq, sql, type SQL } from "drizzle-orm";

/**
 * The `agent_runs` rows that belong to one chat thread: the chat-turn workflow
 * keeps its thread id in `metadata.threadId`, and the partial unique index
 * `CHAT_THREAD_ACTIVE_RUN_INDEX` is keyed on the same jsonb expression. Every
 * reader of a thread's runs (turn admission, tool carry-over) composes this one
 * predicate so the expression cannot drift from the index it fronts.
 */
export function chatThreadRunsWhere(args: {
  userId: string;
  threadId: string;
  workflowSlug: string;
}): SQL | undefined {
  return and(
    eq(agentRuns.userId, args.userId),
    eq(agentRuns.workflowSlug, args.workflowSlug),
    sql`${agentRuns.metadata} ->> 'threadId' = ${args.threadId}`,
  );
}
