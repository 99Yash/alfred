import { db, rowsFromExecute } from "@alfred/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** A sub-agent of a sub-agent of a chat turn is the deepest chain today; this caps a bad cycle. */
const MAX_PARENT_HOPS = 4;

const userTurnRowSchema = z.object({ id: z.string() });

/**
 * The user's chat turn that started a run: the evidence of a claim that the user said in chat
 * (ADR-0123). A chat-turn run names its turn in `metadata.userMessageId` (admission writes it; the
 * user row has no `run_id`). A sub-agent run follows `metadata.subAgent.parentRunId` to its chat
 * run, in one recursive query. `null` when no user turn started the run (a workflow, a scheduled
 * job): then no user claim exists.
 */
export async function readUserTurnOfRun(userId: string, runId: string): Promise<string | null> {
  const result = await db().execute(sql`
    WITH RECURSIVE chain(hop, user_message_id, parent_run_id) AS (
      SELECT 0, r.metadata ->> 'userMessageId', r.metadata -> 'subAgent' ->> 'parentRunId'
      FROM agent_runs r
      WHERE r.id = ${runId} AND r.user_id = ${userId}
      UNION ALL
      SELECT chain.hop + 1, p.metadata ->> 'userMessageId', p.metadata -> 'subAgent' ->> 'parentRunId'
      FROM chain
      JOIN agent_runs p ON p.id = chain.parent_run_id AND p.user_id = ${userId}
      WHERE chain.hop < ${MAX_PARENT_HOPS} AND chain.user_message_id IS NULL
    )
    SELECT m.id
    FROM chain
    JOIN chat_messages m ON m.id = chain.user_message_id AND m.user_id = ${userId} AND m.role = 'user'
    ORDER BY chain.hop
    LIMIT 1
  `);

  return rowsFromExecute(result, userTurnRowSchema)[0]?.id ?? null;
}
