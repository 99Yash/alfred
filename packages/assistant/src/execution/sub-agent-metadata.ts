import { getPath } from "@alfred/contracts";
import { agentRuns } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { subAgentIdSchema } from "@alfred/assistant/tool-runtime";

/**
 * The workflow every sub-agent run executes, regardless of which workflow
 * spawned it. The user-authored-brief workflow is the one that's sub-agent
 * aware (its `initialState` branches on `subAgent` metadata for the focused
 * prompt / model / restricted tools), and it runs from a bare brief — so it
 * works even when the parent's own workflow is thread-coupled and can't
 * (e.g. chat-turn, which requires a `threadId`). Lives in this leaf module so
 * `sub-agents.ts` can reference it without importing the workflow (which would
 * cycle through the tool registry).
 */
export const SUB_AGENT_WORKFLOW_SLUG = "__user-authored-brief__";

/**
 * The chat turn a sub-agent was spawned from, when there was one. Lets the
 * child stream its own tool trail back into that turn's bubble (nested under
 * the `spawn_sub_agent` card) instead of working invisibly.
 *
 * Optional because a sub-agent's parent is not always a chat turn — a cron
 * brief or a background boss run has no thread, and those children simply
 * publish nothing. `messageId` is the parent's assistant message, stable for
 * the whole turn (it survives HIL parks and resumes), so it stays a valid
 * stream key for as long as the child can be running.
 */
const subAgentChatOriginSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict();

export type SubAgentChatOrigin = z.infer<typeof subAgentChatOriginSchema>;

export const subAgentMetadataSchema = z
  .object({
    kind: z.literal("sub_agent"),
    parentRunId: z.string().min(1),
    subId: subAgentIdSchema,
    parentToolCallId: z.string().min(1),
    // Absent on rows written before live sub-agent trails, and on any
    // non-chat parent — both degrade to "child runs silently", never an error.
    chat: subAgentChatOriginSchema.optional(),
  })
  .strict();

export type SubAgentMetadata = z.infer<typeof subAgentMetadataSchema>;

export function readSubAgentMetadata(metadata: unknown): SubAgentMetadata | null {
  const parsed = subAgentMetadataSchema.safeParse(getPath(metadata, "subAgent"));
  return parsed.success ? parsed.data : null;
}

/**
 * The `agent_runs` WHERE fragment for "the runs whose parent is `parentRunId`" —
 * the trusted `subAgent.parentRunId` pointer `spawnSubAgent` stamps. The single
 * home of that predicate: the cancel cascade, `listSpawnedChildRuns`, and the
 * usage fold all read children through it, so they cannot drift on the pointer's
 * shape. Callers that need to scope a run to its user add `eq(agentRuns.userId,
 * ...)` alongside it; `parentRunId` is a globally unique run id, so the pointer
 * alone is unambiguous, but the partial index keyed on `(user_id, expr)` serves
 * only queries that also filter `user_id`.
 */
export function subAgentParentRunIdMatches(parentRunId: string) {
  return sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${parentRunId}`;
}

/**
 * The wake-condition signal a sub-agent fires (via the executor's terminal
 * commit) so its waiting parent flips back to `runnable`. ADR-0073: keyed by
 * the child's run id, so a boss awaiting several children wakes only for the
 * one that finished. Both the `await_sub_agent` park and the terminal-signal
 * site derive the name from here — one definition, no string drift.
 */
export function subAgentDoneSignalName(childRunId: string): string {
  return `sub_agent_done:${childRunId}`;
}
