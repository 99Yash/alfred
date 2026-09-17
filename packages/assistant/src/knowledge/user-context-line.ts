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

/** One indexed row, already collapsed to a single line and already capped. */
export interface UserContextLine {
  /** Prompt-ready prose, at most `USER_CONTEXT_LINE_MAX_CHARS` characters. */
  text: string;
  /** When the cold-start run wrote the chunk, so a reader can say how old the prior is. */
  recordedAt: Date;
}

/**
 * The prompt budget for the whole prior, in characters.
 *
 * Measured 2026-09-17, by rendering `renderObservations` twice over the same
 * fixture: a line AT this cap grows the triage observations block from 383 B
 * (~95 tokens) to 1452 B (~362 tokens) — a delta of 1069 B / ~267 tokens. Of
 * that delta, ~400 B is the fixed handling rule beside the line. A user with no
 * cold-start chunk pays 0 B, because the render is skipped entirely.
 *
 * A raise is a visible diff and a review question (Tier 3), not a gate.
 */
export const USER_CONTEXT_LINE_MAX_CHARS = 600;

/** A line of pure punctuation or whitespace is a research header, not a prior. */
const HAS_ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

/**
 * Read the user's most recent cold-start research chunk as a capped one-line
 * prior. `null` when the user has no such chunk, or when the chunk holds no
 * readable content.
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
 * The ONLY constructor of a `UserContextLine`, so the cap and the single-line
 * rule cannot be bypassed. The newline collapse is not cosmetic: the value is
 * rendered inside a `===`-delimited observations block, and a chunk with a blank
 * line would otherwise forge a section header above the derived signals — the
 * same defense `renderObservations` applies to a standing-instruction phrasing.
 */
function buildUserContextLine(content: string, recordedAt: Date): UserContextLine | null {
  const collapsed = content.replace(/\s+/g, " ").trim();

  if (!HAS_ALPHANUMERIC_RE.test(collapsed)) return null;

  const text =
    collapsed.length > USER_CONTEXT_LINE_MAX_CHARS
      ? `${collapsed.slice(0, USER_CONTEXT_LINE_MAX_CHARS - 1).trimEnd()}…`
      : collapsed;

  return { text, recordedAt };
}
