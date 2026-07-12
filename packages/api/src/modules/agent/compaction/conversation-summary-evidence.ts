import { db } from "@alfred/db";
import {
  chatAttachments,
  chatMessages,
  type ChatAttachment,
  type ChatMessage,
} from "@alfred/db/schemas";
import { and, asc, eq, gt, inArray, lt, lte, or } from "drizzle-orm";

import type { AgentDbExecutor } from "../types";
import type { ChatSummaryWatermark } from "./chat-context-store";
import type { ConversationSummaryEvidence } from "./conversation-summary-generator";
import type { ConversationSummary } from "./conversation-summary";

export const CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS = 64_000;

type EvidenceMessageRow = Pick<
  ChatMessage,
  "id" | "role" | "content" | "status" | "errorKind" | "toolCalls" | "createdAt"
>;
type EvidenceAttachmentRow = Pick<
  ChatAttachment,
  "id" | "messageId" | "name" | "mime" | "status" | "degradedText" | "failureReason"
>;

export interface LoadedConversationSummaryEvidence {
  evidence: ConversationSummaryEvidence;
  watermark: ChatSummaryWatermark;
}

/** Load only records newly eligible after the prior compound watermark. */
export async function loadConversationSummaryEvidence({
  userId,
  threadId,
  priorSummary,
  afterWatermark,
  throughWatermark,
  ex = db(),
}: {
  userId: string;
  threadId: string;
  priorSummary: ConversationSummary | null;
  afterWatermark: ChatSummaryWatermark | null;
  throughWatermark: ChatSummaryWatermark;
  ex?: AgentDbExecutor;
}): Promise<LoadedConversationSummaryEvidence> {
  const lowerBound = afterWatermark
    ? or(
        gt(chatMessages.createdAt, afterWatermark.createdAt),
        and(
          eq(chatMessages.createdAt, afterWatermark.createdAt),
          gt(chatMessages.id, afterWatermark.messageId),
        ),
      )
    : undefined;
  const upperBound = or(
    lt(chatMessages.createdAt, throughWatermark.createdAt),
    and(
      eq(chatMessages.createdAt, throughWatermark.createdAt),
      lte(chatMessages.id, throughWatermark.messageId),
    ),
  );
  const messages = await ex
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      status: chatMessages.status,
      errorKind: chatMessages.errorKind,
      toolCalls: chatMessages.toolCalls,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, userId),
        eq(chatMessages.threadId, threadId),
        lowerBound,
        upperBound,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  if (messages.length === 0) throw new Error("conversation_summary_no_new_messages");
  const lastMessage = messages[messages.length - 1]!;
  if (
    lastMessage.id !== throughWatermark.messageId ||
    lastMessage.createdAt.getTime() !== throughWatermark.createdAt.getTime()
  ) {
    throw new Error("conversation_summary_watermark_not_loaded");
  }

  const messageIds = messages.map((message) => message.id);
  const attachments = await ex
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      name: chatAttachments.name,
      mime: chatAttachments.mime,
      status: chatAttachments.status,
      degradedText: chatAttachments.degradedText,
      failureReason: chatAttachments.failureReason,
    })
    .from(chatAttachments)
    .where(and(eq(chatAttachments.userId, userId), inArray(chatAttachments.messageId, messageIds)))
    .orderBy(
      asc(chatAttachments.messageId),
      asc(chatAttachments.position),
      asc(chatAttachments.id),
    );

  return {
    evidence: buildConversationSummaryEvidence({ priorSummary, messages, attachments }),
    watermark: throughWatermark,
  };
}

export function buildConversationSummaryEvidence({
  priorSummary,
  messages,
  attachments,
}: {
  priorSummary: ConversationSummary | null;
  messages: readonly EvidenceMessageRow[];
  attachments: readonly EvidenceAttachmentRow[];
}): ConversationSummaryEvidence {
  const tools = messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => ({
      id: call.toolCallId,
      content: {
        messageId: message.id,
        name: call.toolName,
        status: call.status,
        args: boundText(call.argsPreview),
        result: boundText(call.resultPreview),
        sanitized: call.sanitized ?? false,
      },
    })),
  );
  return {
    priorSummary,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: {
        text: boundText(message.content),
        status: message.status,
        errorKind: message.errorKind,
        createdAt: message.createdAt.toISOString(),
      },
    })),
    tools,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      content: {
        messageId: attachment.messageId,
        name: attachment.name,
        mime: attachment.mime,
        status: attachment.status,
        degradedText: boundText(attachment.degradedText),
        failureReason: boundText(attachment.failureReason),
      },
    })),
  };
}

function boundText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.length <= CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS) return value;
  return `${value.slice(0, CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS)}\n[truncated]`;
}
