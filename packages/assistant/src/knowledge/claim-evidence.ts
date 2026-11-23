import { db } from "@alfred/db";
import { agentRuns, chatMessages } from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";

/** A sub-agent of a sub-agent of a chat turn is the deepest chain today; this caps a bad cycle. */
const MAX_PARENT_HOPS = 4;

/**
 * The user's chat turn that started a run: the evidence of a claim that the user said in chat
 * (ADR-0123). A sub-agent run follows `metadata.subAgent.parentRunId` to its chat turn. `null`
 * when no user turn started the run (a workflow, a scheduled job): then no user claim exists.
 */
export async function readUserTurnOfRun(userId: string, runId: string): Promise<string | null> {
  let current: string | null = runId;

  for (let hop = 0; current !== null && hop <= MAX_PARENT_HOPS; hop++) {
    const [turn] = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.runId, current),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);

    if (turn) return turn.id;

    const [run] = await db()
      .select({
        parentRunId: sql<string | null>`${agentRuns.metadata} -> 'subAgent' ->> 'parentRunId'`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, current)))
      .limit(1);

    current = run?.parentRunId ?? null;
  }

  return null;
}
