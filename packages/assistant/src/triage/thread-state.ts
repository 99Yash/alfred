import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  extractGmailDocumentBody,
  parseGmailDocumentMetadata,
  type GmailDocumentMetadata,
} from "@alfred/contracts";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  TRIAGE_RECENT_MESSAGE_LIMIT,
  TRIAGE_RECENT_MESSAGE_MAX_CHARS,
  TRIAGE_THREAD_STATE_ROW_LIMIT,
} from "./constants";
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

/** A bounded excerpt of one prior message in the thread, fed to the classifier. */
export interface ThreadMessageContext {
  /** Whether the user sent it or received it. */
  direction: "sent" | "received";
  /** Authored time, if known. */
  authoredAt: Date | null;
  /** Body lede (header block stripped, whitespace-collapsed, length-capped). */
  snippet: string;
}

export interface ThreadState {
  /** Newest authored time across the thread for a message the USER sent, or null. */
  lastUserReplyAt: Date | null;
  /** Direction of the newest message in the thread (excluding `excludeDocumentId`). */
  newestDirection: "sent" | "received" | null;
  /** Total messages on file for the thread (sent + received), excluding the exclusion. */
  messageCount: number;
  /**
   * The most recent prior messages (newest first, excluding `excludeDocumentId`),
   * as bounded body excerpts. ADR-0051 #8 fed only thread *dates*; this extends
   * the same observation with the prior messages' *content* so the classifier of
   * a trailing low-signal message (e.g. a ClickUp/Linear bot confirming it filed
   * a task) can see an earlier live ask/assignment in the SAME thread and not
   * collapse the whole thread to `done`. Still a fed hint — the model owns the
   * category (ADR-0051 amendment 2026-06-13).
   */
  recentMessages: ThreadMessageContext[];
}

const EMPTY: ThreadState = {
  lastUserReplyAt: null,
  newestDirection: null,
  messageCount: 0,
  recentMessages: [],
};

/** Body lede for the fed thread context: drop the leading header block, collapse whitespace, cap length. PURE. */
export function buildThreadSnippet(
  title: string | null,
  content: string | null,
  metadata: GmailDocumentMetadata,
  max: number,
): string {
  const body = extractGmailDocumentBody(content, {
    from: metadata.from,
    to: metadata.to,
    cc: metadata.cc,
    subject: title,
  })
    .replace(/\s+/g, " ")
    .trim();
  const base = body || (title ?? "").trim();
  return base.length > max ? `${base.slice(0, max).trimEnd()}…` : base;
}

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
  const threadWhere = and(
    eq(documents.userId, args.userId),
    eq(documents.source, "gmail"),
    eq(documents.sourceThreadId, args.sourceThreadId),
    args.excludeDocumentId ? ne(documents.id, args.excludeDocumentId) : undefined,
  );
  const newestFirst = sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`;

  const rows = await db()
    .select({
      authoredAt: documents.authoredAt,
      // Canonical sent detection (isSent flag OR the raw SENT label) so a
      // SENT-labelled doc without the flag is not mis-counted as received,
      // which would corrupt newestDirection / lastUserReplyAt.
      isSent: gmailSentSql(),
    })
    .from(documents)
    .where(threadWhere)
    // Order before the cap so a >500-message thread truncates deterministically
    // to its most recent rows — otherwise Postgres returns an arbitrary subset
    // and `newestDirection`/`lastUserReplyAt` could be computed from stale rows.
    // NULLS LAST so undated rows (no ordering signal) never displace a dated
    // one out of the window. `documents.id` is a deterministic tiebreaker so
    // two messages sharing an authoredAt (same-second replies) resolve the
    // "newest" slot identically every run. `documents_thread_idx` supports it.
    .orderBy(newestFirst)
    .limit(TRIAGE_THREAD_STATE_ROW_LIMIT);

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

  // Pull bodies only for the few messages we feed to the classifier. The wider
  // 500-row pass above stays metadata-only, so long Gmail threads do not drag
  // hundreds of full email bodies through every triage run.
  const recentRows = await db()
    .select({
      authoredAt: documents.authoredAt,
      title: documents.title,
      content: documents.content,
      metadata: documents.metadata,
      isSent: gmailSentSql(),
    })
    .from(documents)
    .where(threadWhere)
    .orderBy(newestFirst)
    .limit(TRIAGE_RECENT_MESSAGE_LIMIT);

  const recentMessages: ThreadMessageContext[] = recentRows
    .map((r) => ({
      direction: r.isSent ? ("sent" as const) : ("received" as const),
      authoredAt: r.authoredAt,
      snippet: buildThreadSnippet(
        r.title,
        r.content,
        parseGmailDocumentMetadata(r.metadata),
        TRIAGE_RECENT_MESSAGE_MAX_CHARS,
      ),
    }))
    .filter((m) => m.snippet.length > 0);

  return {
    lastUserReplyAt,
    newestDirection: newest ? (newest.isSent ? "sent" : "received") : null,
    messageCount: siblings.length,
    recentMessages,
  };
}
