import type { ChatMessageToolCall } from "@alfred/db/schemas";
import { db } from "@alfred/db";
import { chatAttachments, chatMessages } from "@alfred/db/schemas";
import { and, desc, eq, ilike, sql } from "drizzle-orm";

export const CHAT_HISTORY_RESULT_LIMIT = 10;
export const CHAT_HISTORY_EXCERPT_CHARS = 4_000;

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ChatMessageToolCall[] | null;
  createdAt: Date;
};
type AttachmentRow = {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  status: string;
  degradedText: string | null;
  failureReason: string | null;
  createdAt: Date;
};

export interface ChatHistoryRetrievalDependencies {
  searchMessages?: (args: {
    userId: string;
    threadId: string;
    query: string;
    limit: number;
  }) => Promise<MessageRow[]>;
  fetchMessage?: (args: {
    userId: string;
    threadId: string;
    id: string;
  }) => Promise<MessageRow | null>;
  fetchToolCall?: (args: {
    userId: string;
    threadId: string;
    id: string;
  }) => Promise<MessageRow | null>;
  fetchAttachment?: (args: {
    userId: string;
    threadId: string;
    id: string;
  }) => Promise<AttachmentRow | null>;
}

export type ReadChatHistoryInput =
  | { mode: "search"; query: string; limit: number }
  | { mode: "fetch"; kind: "message" | "tool_call" | "attachment"; id: string };

/** Authenticated, current-thread-only access to raw evidence behind a lossy summary. */
export async function readChatHistory(
  args: { userId: string; threadId: string; input: ReadChatHistoryInput },
  dependencies: ChatHistoryRetrievalDependencies = {},
): Promise<unknown> {
  if (args.input.mode === "search") {
    const limit = Math.min(Math.max(args.input.limit, 1), CHAT_HISTORY_RESULT_LIMIT);
    const rows = await (dependencies.searchMessages ?? searchMessages)({
      userId: args.userId,
      threadId: args.threadId,
      query: args.input.query,
      limit,
    });
    return {
      ok: true,
      mode: "search",
      query: args.input.query,
      results: rows.slice(0, limit).map(messageEvidence),
    };
  }

  if (args.input.kind === "attachment") {
    const row = await (dependencies.fetchAttachment ?? fetchAttachment)({
      userId: args.userId,
      threadId: args.threadId,
      id: args.input.id,
    });
    return row
      ? { ok: true, mode: "fetch", found: true, result: attachmentEvidence(row) }
      : { ok: true, mode: "fetch", found: false, kind: args.input.kind, id: args.input.id };
  }

  const fetchInput = args.input;
  const loader =
    fetchInput.kind === "message"
      ? (dependencies.fetchMessage ?? fetchMessage)
      : (dependencies.fetchToolCall ?? fetchToolCall);
  const row = await loader({ userId: args.userId, threadId: args.threadId, id: fetchInput.id });
  if (!row)
    return { ok: true, mode: "fetch", found: false, kind: fetchInput.kind, id: fetchInput.id };
  if (fetchInput.kind === "message") {
    return { ok: true, mode: "fetch", found: true, result: messageEvidence(row) };
  }
  const callId = fetchInput.id;
  const call = row.toolCalls?.find((candidate) => candidate.toolCallId === callId);
  return call
    ? {
        ok: true,
        mode: "fetch",
        found: true,
        result: {
          kind: "tool_call",
          id: call.toolCallId,
          messageId: row.id,
          createdAt: row.createdAt.toISOString(),
          toolName: call.toolName,
          status: call.status,
          args: excerpt(call.argsPreview ?? ""),
          outcome: excerpt(call.resultPreview ?? ""),
          sanitized: call.sanitized ?? false,
        },
      }
    : { ok: true, mode: "fetch", found: false, kind: fetchInput.kind, id: fetchInput.id };
}

function messageEvidence(row: MessageRow) {
  return {
    kind: "message",
    id: row.id,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    content: excerpt(row.content),
    toolCallIds: (row.toolCalls ?? [])
      .map((call) => call.toolCallId)
      .slice(0, CHAT_HISTORY_RESULT_LIMIT),
  };
}

function attachmentEvidence(row: AttachmentRow) {
  return {
    kind: "attachment",
    id: row.id,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
    name: row.name,
    mime: row.mime,
    status: row.status,
    extractedText: excerpt(row.degradedText ?? ""),
    failureReason: row.failureReason ? excerpt(row.failureReason) : null,
  };
}

function excerpt(value: string): { text: string; truncated: boolean; originalChars: number } {
  const clean = value.replaceAll("\u0000", "");
  return {
    text: clean.slice(0, CHAT_HISTORY_EXCERPT_CHARS),
    truncated: clean.length > CHAT_HISTORY_EXCERPT_CHARS,
    originalChars: clean.length,
  };
}

async function searchMessages(args: {
  userId: string;
  threadId: string;
  query: string;
  limit: number;
}) {
  return db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      toolCalls: chatMessages.toolCalls,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        ilike(chatMessages.content, `%${escapeLike(args.query)}%`),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(args.limit);
}

async function fetchMessage(args: { userId: string; threadId: string; id: string }) {
  const [row] = await db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      toolCalls: chatMessages.toolCalls,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        eq(chatMessages.id, args.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function fetchToolCall(args: { userId: string; threadId: string; id: string }) {
  const [row] = await db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      toolCalls: chatMessages.toolCalls,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        sql`${chatMessages.toolCalls} @> ${JSON.stringify([{ toolCallId: args.id }])}::jsonb`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function fetchAttachment(args: { userId: string; threadId: string; id: string }) {
  const [row] = await db()
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      name: chatAttachments.name,
      mime: chatAttachments.mime,
      status: chatAttachments.status,
      degradedText: chatAttachments.degradedText,
      failureReason: chatAttachments.failureReason,
      createdAt: chatAttachments.createdAt,
    })
    .from(chatAttachments)
    .innerJoin(chatMessages, eq(chatMessages.id, chatAttachments.messageId))
    .where(
      and(
        eq(chatAttachments.userId, args.userId),
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        eq(chatAttachments.id, args.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
