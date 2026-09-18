import { db } from "@alfred/db";
import { memoryChunks } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

/**
 * A bounded prior drawn from the user's cold-start research chunk (ADR-0050 D1,
 * first slice; permitted by the ADR-0051 amendment §6 as "a single deterministic
 * fact fed as a hint, not a rewrite").
 *
 * WHY this and not `readUserContext(userId, { include: ["recent_memory"] })`:
 * that reader orders `memory_chunks` by recency and caps at six rows, so six
 * newer `thread_summary` rows evict the cold-start chunk with no error. It also
 * returns 900 characters per chunk against this budget and runs five queries the
 * classifier does not need. A cold-start reader must ask for the chunk BY KIND.
 *
 * WHY it is not a memory search: the triage classifier runs once per inbound
 * email, and #435 owns that latency budget. `readUserContextLine` takes no query
 * argument, so no search is expressible on this path — the bound holds by the
 * signature, not by a comment.
 */

/** One indexed row, collapsed to a single line. */
export interface UserContextLine {
  /**
   * Prompt-ready prose on ONE line. NOT capped here, deliberately: the byte
   * budget belongs to the prompt, so it is applied by the render site
   * (`triage/classify.ts`, `USER_CONTEXT_LINE_MAX_CHARS`). A cap applied here
   * would be a claim this module cannot keep — `UserContextLine` is a plain
   * exported interface, so any caller can build an uncapped literal and reach
   * the same prompt. Capping where the prompt is built holds on every path.
   */
  text: string;
  /** When the cold-start run wrote the chunk, so a reader can say how old the prior is. */
  recordedAt: Date;
}

/** A line of pure punctuation or whitespace is a research header, not a prior. */
const HAS_ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

/**
 * Read the user's most recent cold-start research chunk as a one-line prior.
 * `null` when the user has no such chunk, or when the chunk holds no readable
 * content. The prompt cap is the render site's job, not this reader's.
 *
 * ONE point read on `memory_chunks_user_kind_idx` (`user_id, kind, created_at`).
 * No embedding, no model, no query parameter.
 */
export async function readUserContextLine(userId: string): Promise<UserContextLine | null> {
  const [row] = await db()
    .select({ content: memoryChunks.content, createdAt: memoryChunks.createdAt })
    .from(memoryChunks)
    .where(and(eq(memoryChunks.userId, userId), eq(memoryChunks.kind, "cold_start_research")))
    .orderBy(desc(memoryChunks.createdAt))
    .limit(1);

  if (!row) return null;

  return buildUserContextLine(row.content, row.createdAt);
}

/**
 * Collapse one stored chunk to a single line, or reject it. The newline collapse
 * is not cosmetic: the value is rendered inside a `===`-delimited observations
 * block, and a chunk with a blank line would otherwise forge a section header
 * above the derived signals — the same defense `renderObservations` applies to a
 * standing-instruction phrasing.
 */
function buildUserContextLine(content: string, recordedAt: Date): UserContextLine | null {
  const collapsed = content.replace(/\s+/g, " ").trim();

  if (!HAS_ALPHANUMERIC_RE.test(collapsed)) return null;

  return { text: collapsed, recordedAt };
}
