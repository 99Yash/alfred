import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  collapseWhitespace,
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
 * Thread state for the classifier (ADR-0051 #8). A hint, never a category
 * mapping. Sent and received mail share one thread group, so one scan sees both.
 */

export interface ThreadMessageContext {
  direction: "sent" | "received";
  authoredAt: Date | null;
  snippet: string;
}

export interface ThreadState {
  lastUserReplyAt: Date | null;
  /** Excludes `excludeDocumentId`, like the fields below. */
  newestDirection: "sent" | "received" | null;
  messageCount: number;
  /** Newest first. Lets a trailing bot line see an earlier open ask in the thread. */
  recentMessages: ThreadMessageContext[];
}

const EMPTY: ThreadState = {
  lastUserReplyAt: null,
  newestDirection: null,
  messageCount: 0,
  recentMessages: [],
};

export function buildThreadSnippet(
  title: string | null,
  content: string | null,
  metadata: GmailDocumentMetadata,
  max: number,
): string {
  const body = collapseWhitespace(
    extractGmailDocumentBody(content, {
      from: metadata.from,
      to: metadata.to,
      cc: metadata.cc,
      subject: title,
    }),
  );

  const base = body || (title ?? "").trim();

  return base.length > max ? `${base.slice(0, max).trimEnd()}…` : base;
}

export interface GetThreadStateArgs {
  userId: string;
  sourceThreadId: string;
  /** Limit outbound drafting context to its inbound mailbox. */
  accountId?: string | undefined;
  /** Usually the message being triaged, so the state is the context it arrives into. */
  excludeDocumentId?: string;
}

export async function getThreadState(args: GetThreadStateArgs): Promise<ThreadState> {
  const threadWhere = and(
    eq(documents.userId, args.userId),
    eq(documents.source, "gmail"),
    eq(documents.sourceThreadId, args.sourceThreadId),
    args.accountId ? eq(documents.accountId, args.accountId) : undefined,
    args.excludeDocumentId ? ne(documents.id, args.excludeDocumentId) : undefined,
  );

  const newestFirst = sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`;

  const rows = await db()
    .select({
      authoredAt: documents.authoredAt,
      // Flag OR the raw SENT label, so an unflagged sent doc is not counted as received.
      isSent: gmailSentSql(),
    })
    .from(documents)
    .where(threadWhere)
    // Order before the cap, so a long thread keeps its newest rows. `id` breaks same-second ties.
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

    // An undated row cannot be newest.
    if (r.authoredAt && (!newest?.authoredAt || r.authoredAt > newest.authoredAt)) {
      newest = { authoredAt: r.authoredAt, isSent: r.isSent };
    }
  }

  // Bodies only for the few fed messages; the wide pass above stays metadata-only.
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

/**
 * Whole-thread closure (ADR-0050). No `excludeDocumentId`: excluding the current
 * message made an older user reply look newest and withheld a fresh ask's todo.
 */
export interface GmailThreadClosure {
  /** The newest message in the whole thread is the user's. Gates the retraction. */
  userHasReplied: boolean;
  /** For logs. */
  newestDirection: ThreadState["newestDirection"];
  /** Read through {@link userRepliedAfterMessage} for the mint. */
  lastUserReplyAt: Date | null;
}

/**
 * The user's newest send is newer than this message. Use this, not
 * `newestDirection === "sent"`, which flips on the next inbound. No date means false.
 */
export function userRepliedAfterMessage(
  lastUserReplyAt: Date | null,
  messageAuthoredAt: Date | null,
): boolean {
  return (
    lastUserReplyAt != null && messageAuthoredAt != null && lastUserReplyAt > messageAuthoredAt
  );
}

export async function readGmailThreadClosure(args: {
  userId: string;
  sourceThreadId: string;
}): Promise<GmailThreadClosure> {
  const thread = await getThreadState(args);

  return {
    userHasReplied: thread.newestDirection === "sent",
    newestDirection: thread.newestDirection,
    lastUserReplyAt: thread.lastUserReplyAt,
  };
}
