/**
 * Where a URL came from (ADR-0130 decision 3). `system.fetch_url` fetches a URL only when it
 * appears in the user's words or in an earlier tool result, so an injected instruction cannot
 * make the model put private text into a URL and send it out. Text that the model wrote never
 * counts: its replies, a compaction summary, a sub-agent brief, and a result that echoes the
 * model, such as a script's return value or a read of chat history. Anthropic's server-side
 * `web_fetch` has the same rule (`url_not_in_prior_context`).
 *
 * The sources, as the owner settled them on 2026-11-19:
 * - The user's words: the user messages and their attachment text in the thread, and the brief
 *   of a workflow run, which the user activated.
 * - Tool results: each stored result of a read that declares `outsideText`, in the chat-turn
 *   runs of the thread, in the run, and in its parent run (a sub-agent). The transcript of a
 *   workflow run adds its trigger event.
 */

import { db, rowsFromExecute } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  CHAT_TURN_WORKFLOW_SLUG,
  chatAttachments,
  chatMessages,
  chatThreadRunMatch,
} from "@alfred/db/schemas";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { listRegisteredTools } from "./internal/registry";
import { MCP_CALL_RISK_FLOOR } from "@alfred/assistant/tool-runtime/mcp";

/** The run that asks to fetch. */
export interface UrlProvenanceRun {
  userId: string;
  runId: string;
  /** The parent run of a sub-agent, or the run itself. */
  scratchpadRunId: string;
  /** The chat thread of the run, or the parent thread of a sub-agent. */
  approvalThreadId: string | undefined;
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

  const appears = (text: SQL) => sql`(${text}) ~ ${pattern}`;
  const { userId } = run;
  const lineage = [...new Set([run.runId, run.scratchpadRunId])];
  const threadId = run.approvalThreadId;
  const tools = outsideTextTools();

  // The runs whose tool results count: the run, its parent, and the chat turns of the thread.
  const resultRuns = sql`(
    select ${agentRuns.id} from ${agentRuns}
    where ${agentRuns.userId} = ${userId}
      and (${agentRuns.id} in ${lineage}
        ${
          threadId === undefined
            ? sql``
            : sql`or (${chatThreadRunMatch(agentRuns, { userId, threadId })})`
        })
  )`;

  const sources: SQL[] = [
    // A staged read. Only a confirmed read lowers the tier of `mcp.call` below its floor, so a
    // write, which can echo the model's input, never counts.
    sql`exists (
      select 1 from ${actionStagings}
      where ${actionStagings.userId} = ${userId}
        and ${actionStagings.runId} in ${resultRuns}
        and ${actionStagings.status} = 'executed'
        and (${actionStagings.toolName} in ${tools.declaredReads}
          or (${actionStagings.toolName} in ${tools.readsByInput}
            and ${actionStagings.riskTier} <> ${MCP_CALL_RISK_FLOOR}))
        and ${appears(sql`${actionStagings.executeResult}::text`)}
    )`,
    // A `fast_path` read writes no staging row. Its result is in the transcript of its run.
    sql`exists (
      select 1 from ${agentRuns},
        jsonb_array_elements(${agentRuns.transcript}) as message,
        jsonb_array_elements(message->'content') as part
      where ${agentRuns.id} in ${resultRuns}
        and message->>'role' = 'tool'
        and jsonb_typeof(message->'content') = 'array'
        and part->>'toolName' in ${tools.declaredReads}
        and ${appears(sql`(part->'output')::text`)}
    )`,
    // A workflow run: the brief that the user activated, and the trigger event in its transcript.
    // A chat turn and a sub-agent are left out: the model wrote a sub-agent brief.
    sql`exists (
      select 1 from ${agentRuns}
      where ${agentRuns.userId} = ${userId}
        and ${agentRuns.id} in ${lineage}
        and ${agentRuns.workflowSlug} <> ${CHAT_TURN_WORKFLOW_SLUG}
        and ${agentRuns.metadata}->'subAgent' is null
        and (${appears(sql`coalesce(${agentRuns.brief}, '')`)}
          or exists (
            select 1 from jsonb_array_elements(${agentRuns.transcript}) as message
            where jsonb_typeof(${agentRuns.transcript}) = 'array'
              and message->>'role' = 'user'
              and ${appears(sql`(message->'content')::text`)}
          ))
    )`,
  ];

  if (threadId !== undefined) {
    sources.push(
      sql`exists (
        select 1 from ${chatMessages}
        where ${chatMessages.userId} = ${userId}
          and ${chatMessages.threadId} = ${threadId}
          and ${chatMessages.role} = 'user'
          and ${appears(sql`${chatMessages.content}`)}
      )`,
      sql`exists (
        select 1 from ${chatAttachments}
        join ${chatMessages} on ${chatMessages.id} = ${chatAttachments.messageId}
        where ${chatMessages.userId} = ${userId}
          and ${chatMessages.threadId} = ${threadId}
          and ${chatMessages.role} = 'user'
          and ${appears(sql`coalesce(${chatAttachments.degradedText}, '')`)}
      )`,
    );
  }

  const result = await db().execute(sql`select (${sql.join(sources, sql` or `)}) as "appears"`);
  const [row] = rowsFromExecute(result, appearsRowSchema);

  return row?.appears === true;
}

const appearsRowSchema = z.object({ appears: z.boolean() });

/** Tool names for the fetch_url sources. Each list holds at least one name, so `in (...)` is valid. */
interface OutsideTextToolNames {
  declaredReads: string[];
  readsByInput: string[];
}

/**
 * The tools whose stored read result counts, from their `outsideText` declaration. A declared
 * read always reads. A tool that reads by its input (`mcp.call`) counts only as a confirmed read.
 */
function outsideTextTools(): OutsideTextToolNames {
  const declaredReads: string[] = [];
  const readsByInput: string[] = [];

  for (const tool of listRegisteredTools()) {
    if (!tool.outsideText) continue;
    (tool.codeModeRead ? declaredReads : readsByInput).push(tool.name);
  }

  // `in ()` is not valid SQL, so an empty list holds one name that no tool has.
  return {
    declaredReads: declaredReads.length > 0 ? declaredReads : [""],
    readsByInput: readsByInput.length > 0 ? readsByInput : [""],
  };
}

/** The characters of a host label, which must not come just before the match. */
const HOST_CHARS = "A-Za-z0-9.-";

/** The characters that continue a path segment or a value, which must not come just after it. */
const SEGMENT_CHARS = "A-Za-z0-9._~%-";

/**
 * The Postgres regular expression for one URL, or `null` for a URL with nothing after its
 * scheme. A neighbour on either side must not continue the URL. A `/`, a `?`, or a `&` may
 * follow, because a shorter URL than the text holds adds no data. A JSON escape (`\n`, `\r`,
 * `\t`) may come before, because a jsonb result is matched as JSON text. The host matches in
 * any case, because a host is not case-sensitive. The rest matches exactly, so the model cannot
 * add data by a change of case.
 */
function urlAppearancePattern(url: string): string | null {
  const key = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  if (key.length === 0) return null;

  const hostEnd = key.search(/[/?#]/);
  const host = hostEnd === -1 ? key : key.slice(0, hostEnd);
  const rest = hostEnd === -1 ? "" : key.slice(hostEnd);

  return (
    `(^|[^${HOST_CHARS}]|\\\\[nrt])` +
    `${anyCase(escapeRegex(host))}${escapeRegex(rest)}` +
    `($|[^${SEGMENT_CHARS}])`
  );
}

/** Each ASCII letter as a bracket of its two cases. The input is already escaped. */
function anyCase(escaped: string): string {
  return escaped.replace(
    /[A-Za-z]/g,
    (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`,
  );
}

/** Escape each character that a Postgres advanced regular expression gives a meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
}
