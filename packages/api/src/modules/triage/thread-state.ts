import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq, ne, sql } from "drizzle-orm";
import { gmailSentSql } from "./sent-mail";

/**
 * Sent-mail-aware thread state (ADR-0051 #8). A BOUNDED OBSERVATION fed to the
 * classifier — "you last replied in this thread on `<date>`" — NOT a hard rule.
 * The model owns the resulting category; we never deterministically map
 * "you already replied" onto a bucket (that taxonomy edge dissolves once the
 * model just sees the fact).
 *
 * Depends on sent-mail ingestion (Phase 1): sent docs carry
 * `metadata.isSent = true` and live in the same `(user_id, source_thread_id)`
 * group as the received mail, so one indexed thread scan sees both sides.
 */

export interface ThreadState {
  /** Newest authored time across the thread for a message the USER sent, or null. */
  lastUserReplyAt: Date | null;
  /** Direction of the newest message in the thread (excluding `excludeDocumentId`). */
  newestDirection: "sent" | "received" | null;
  /** Total messages on file for the thread (sent + received), excluding the exclusion. */
  messageCount: number;
}

const EMPTY: ThreadState = {
  lastUserReplyAt: null,
  newestDirection: null,
  messageCount: 0,
};

const THREAD_STATE_ROW_LIMIT = 500;

export interface GetThreadStateArgs {
  userId: string;
  sourceThreadId: string;
  /**
   * Document to exclude — typically the message currently being triaged, so
   * "thread state" describes the context the new message arrives into rather
   * than counting itself.
   */
  excludeDocumentId?: string;
}

/**
 * Read bounded thread observations from `documents`. One indexed scan on
 * `(user_id, source, source_thread_id)`; threads are small at single-user
 * scale, so we resolve direction/recency in JS rather than two aggregate
 * queries. Returns the empty state for a brand-new thread.
 */
export async function getThreadState(args: GetThreadStateArgs): Promise<ThreadState> {
  const rows = await db()
    .select({
      id: documents.id,
      authoredAt: documents.authoredAt,
      // Canonical sent detection (isSent flag OR the raw SENT label) so a
      // SENT-labelled doc without the flag is not mis-counted as received,
      // which would corrupt newestDirection / lastUserReplyAt.
      isSent: gmailSentSql(),
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
        eq(documents.sourceThreadId, args.sourceThreadId),
        args.excludeDocumentId ? ne(documents.id, args.excludeDocumentId) : undefined,
      ),
    )
    // Order before the cap so a >500-message thread truncates deterministically
    // to its most recent rows — otherwise Postgres returns an arbitrary subset
    // and `newestDirection`/`lastUserReplyAt` could be computed from stale rows.
    // NULLS LAST so undated rows (no ordering signal) never displace a dated
    // one out of the window. `documents.id` is a deterministic tiebreaker so
    // two messages sharing an authoredAt (same-second replies) resolve the
    // "newest" slot identically every run. `documents_thread_idx` supports it.
    .orderBy(sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`)
    .limit(THREAD_STATE_ROW_LIMIT);

  const siblings = rows;
  if (siblings.length === 0) return EMPTY;

  let lastUserReplyAt: Date | null = null;
  let newest: { authoredAt: Date | null; isSent: boolean } | null = null;
  for (const r of siblings) {
    if (r.isSent && r.authoredAt && (!lastUserReplyAt || r.authoredAt > lastUserReplyAt)) {
      lastUserReplyAt = r.authoredAt;
    }
    // Order by authoredAt; rows without a timestamp can't win the "newest"
    // slot (an undated row gives us no ordering signal).
    if (r.authoredAt && (!newest?.authoredAt || r.authoredAt > newest.authoredAt)) {
      newest = { authoredAt: r.authoredAt, isSent: r.isSent };
    }
  }

  return {
    lastUserReplyAt,
    newestDirection: newest ? (newest.isSent ? "sent" : "received") : null,
    messageCount: siblings.length,
  };
}
