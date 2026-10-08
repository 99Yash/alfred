import { db } from "@alfred/db";
import { memoryChunks } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { holdsResearchPrior } from "./cold-start/no-profile";

/**
 * A one-line prior from the cold-start research chunk (ADR-0050 D1, ADR-0051 §6).
 * Not `readUserContext`: it orders chunks by recency, so newer summaries evict
 * this one. Not a memory search: triage runs per email, so there is no query parameter.
 */

/** One indexed row, collapsed to a single line. */
export interface UserContextLine {
  /** One line, not capped: the render site (`triage/classify.ts`) owns the byte budget. */
  text: string;
  /** When the chunk was written, so a reader can tell its age. */
  recordedAt: Date;
}

/**
 * The latest cold-start chunk as one line, or `null`. One point read on
 * `memory_chunks_user_kind_idx`; no embedding, no model.
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
 * Fold the chunk to one line, or refuse it. One line matters: a blank line
 * could forge a section header in the `===`-delimited observations block.
 * `holdsResearchPrior` refuses headers and "no public profile" lines.
 */
function buildUserContextLine(content: string, recordedAt: Date): UserContextLine | null {
  const collapsed = content.replace(/\s+/g, " ").trim();

  if (!holdsResearchPrior(collapsed)) return null;

  return { text: collapsed, recordedAt };
}
