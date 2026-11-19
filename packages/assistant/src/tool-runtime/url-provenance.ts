/**
 * Where a URL came from (ADR-0130 decision 3). `system.fetch_url` fetches a URL only when it
 * appears in the user's words or in an earlier tool result, so an injected instruction cannot
 * make the model put private text into a URL and send it out. Text that the model wrote never
 * counts: its replies, a compaction summary, and a sub-agent brief. Anthropic's server-side
 * `web_fetch` has the same rule (`url_not_in_prior_context`).
 *
 * The sources, as the owner settled them on 2026-11-19:
 * - A chat turn, and a sub-agent of one: the user messages and their attachment text in the
 *   thread, and the stored tool results of each chat-turn run of the thread.
 * - Each run: the stored tool results of the run itself, with the nested reads of a script.
 * - A workflow run, which has no thread: its user messages (the brief that the user activated,
 *   and the trigger event).
 */

import { db, rowsFromExecute } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  chatAttachments,
  chatMessages,
  chatThreadRunMatch,
} from "@alfred/db/schemas";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

/** The run that asks to fetch. */
export interface UrlProvenanceRun {
  userId: string;
  runId: string;
  /** The chat thread of the run, or the parent thread of a sub-agent. */
  approvalThreadId: string | undefined;
  /** A workflow run: its user messages are the brief that the user activated, and the trigger. */
  workflowRun: boolean;
}

/**
 * Whether `url` appears in a source of the run. The match drops the scheme and the final `/`, so
 * "yashk.xyz" from the user allows "https://yashk.xyz/". The text around the match must end the
 * URL, so the model cannot add a host label, a path segment, or a query that the text lacks.
 */
export async function urlAppearsInPriorContext(
  run: UrlProvenanceRun,
  url: string,
): Promise<boolean> {
  const pattern = urlAppearancePattern(url);

  if (pattern === null) return false;

  const appears = (column: SQL) => sql`(${column}) ~ ${pattern}`;
  const threadId = run.approvalThreadId;

  const sources: SQL[] = [
    // The run's own results, with the nested reads of a script, which share its run id.
    sql`exists (
      select 1 from ${actionStagings}
      where ${actionStagings.userId} = ${run.userId}
        and ${actionStagings.runId} = ${run.runId}
        and ${actionStagings.status} = 'executed'
        and ${appears(sql`${actionStagings.executeResult}::text`)}
    )`,
  ];

  if (threadId !== undefined) {
    sources.push(
      sql`exists (
        select 1 from ${chatMessages}
        where ${chatMessages.userId} = ${run.userId}
          and ${chatMessages.threadId} = ${threadId}
          and ${chatMessages.role} = 'user'
          and ${appears(sql`${chatMessages.content}`)}
      )`,
      sql`exists (
        select 1 from ${chatAttachments}
        join ${chatMessages} on ${chatMessages.id} = ${chatAttachments.messageId}
        where ${chatMessages.userId} = ${run.userId}
          and ${chatMessages.threadId} = ${threadId}
          and ${chatMessages.role} = 'user'
          and ${appears(sql`${chatAttachments.degradedText}`)}
      )`,
      sql`exists (
        select 1 from ${actionStagings}
        where ${actionStagings.userId} = ${run.userId}
          and ${actionStagings.status} = 'executed'
          and ${actionStagings.runId} in (
            select ${agentRuns.id} from ${agentRuns}
            where ${chatThreadRunMatch(agentRuns, { userId: run.userId, threadId })}
          )
          and ${appears(sql`${actionStagings.executeResult}::text`)}
      )`,
    );
  }

  if (run.workflowRun) {
    sources.push(
      sql`exists (
        select 1 from ${agentRuns}, jsonb_array_elements(${agentRuns.transcript}) as message
        where ${agentRuns.id} = ${run.runId}
          and ${agentRuns.userId} = ${run.userId}
          and message->>'role' = 'user'
          and ${appears(sql`(message->'content')::text`)}
      )`,
    );
  }

  const result = await db().execute(sql`select (${sql.join(sources, sql` or `)}) as "appears"`);
  const [row] = rowsFromExecute(result, appearsRowSchema);

  return row?.appears === true;
}

const appearsRowSchema = z.object({ appears: z.boolean() });

/** The characters of a host label, which must not come just before the match. */
const HOST_CHARS = "A-Za-z0-9.-";

/** The characters that continue a path segment or a value, which must not come just after it. */
const SEGMENT_CHARS = "A-Za-z0-9._~%-";

/**
 * The Postgres regular expression for one URL, or `null` for a URL with nothing after its
 * scheme. A neighbour on either side must not continue the URL. A `/`, a `?`, or a `&` may
 * follow, because a shorter URL than the text holds adds no data.
 */
function urlAppearancePattern(url: string): string | null {
  const key = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  if (key.length === 0) return null;

  return `(^|[^${HOST_CHARS}])${escapeRegex(key)}($|[^${SEGMENT_CHARS}])`;
}

/** Escape each character that a Postgres advanced regular expression gives a meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
}
