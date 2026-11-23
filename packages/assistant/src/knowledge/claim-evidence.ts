import { collapseWhitespace } from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { actionStagings, chatMessages } from "@alfred/db/schemas";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** A sub-agent of a sub-agent of a chat turn is the deepest chain today; this caps a bad cycle. */
const MAX_PARENT_HOPS = 4;

const userTurnRowSchema = z.object({ id: z.string() });

/**
 * The user's chat turn that started a run, in the thread of the call (ADR-0115 rule 1: the
 * message belongs to the same user and the same thread). A chat-turn run names its turn in
 * `metadata.userMessageId` (admission writes it; the user row has no `run_id`). A sub-agent run
 * follows `metadata.subAgent.parentRunId` to its chat run, in one recursive query. `null` when no
 * user turn of that thread started the run (a workflow, a scheduled job).
 *
 * This proves only that the user sent a message. It does not prove that the message asked for a
 * write (ADR-0115, "Honest limit of rule 1"). {@link findUserWordsInThread} proves the words.
 */
export async function readUserTurnOfRun(
  userId: string,
  runId: string,
  threadId: string,
): Promise<string | null> {
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
      AND m.thread_id = ${threadId}
    ORDER BY chain.hop
    LIMIT 1
  `);

  return rowsFromExecute(result, userTurnRowSchema)[0]?.id ?? null;
}

/** How far back in a thread the words of an instruction can come from. */
const USER_TURNS_SEARCHED = 50;

/** The form that two texts are compared in: one space, lower case, plain quote marks. */
function comparable(text: string): string {
  return collapseWhitespace(text)
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

/**
 * Whether the words name a sender: the address or domain itself, or the name of its domain as a
 * whole word ("Polylane" names `polylane.com` and `team@polylane.com`). A short or a shared name
 * (`co` of `acme.co.uk`) does not count, so that target needs the user's approval.
 */
function nameAppears(words: string, name: string): boolean {
  const full = comparable(name);

  if (words.includes(full)) return true;

  const labels = full.slice(full.lastIndexOf("@") + 1).split(".");
  const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];

  return core !== undefined && core.length >= 3 && words.split(/[^a-z0-9-]+/).includes(core);
}

/**
 * The newest user turn of the thread that contains `words` exactly (after {@link comparable}),
 * when `words` also contains each of `names` (the senders that an instruction targets). `null`
 * when the words are not the user's own: then only the user's approval of the exact call can
 * make the claim the user's (ADR-0123, owner decision 2026-11-23).
 *
 * An earlier turn counts, so "do that for Acme too" after an earlier sentence still matches the
 * earlier sentence. A text that the agent read (a mail, a page) cannot supply the words, because
 * only `role = 'user'` rows of this thread are searched.
 */
export async function findUserWordsInThread(args: {
  userId: string;
  threadId: string;
  words: string;
  names: readonly string[];
}): Promise<string | null> {
  const words = comparable(args.words);

  if (words.length === 0) return null;

  if (!args.names.every((name) => nameAppears(words, name))) return null;

  const turns = await db()
    .select({ id: chatMessages.id, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        eq(chatMessages.role, "user"),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(USER_TURNS_SEARCHED);

  return turns.find((turn) => comparable(turn.content).includes(words))?.id ?? null;
}

/**
 * Whether the user approved the card of this exact staged call: the approve path sets the status
 * and the decision time. A call with no card has no decision time.
 */
export async function userApprovedStaging(userId: string, stagingId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: actionStagings.id })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.id, stagingId),
        eq(actionStagings.userId, userId),
        eq(actionStagings.status, "approved"),
        isNotNull(actionStagings.decidedAt),
      ),
    )
    .limit(1);

  return row !== undefined;
}
