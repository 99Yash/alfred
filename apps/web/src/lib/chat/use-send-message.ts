import {
  isEmptyChatTurnInput,
  toMessage,
  turnStartResponseSchema,
  type ChatModelTier,
} from "@alfred/contracts";
import { toSyncedChatAttachment, toSyncedUserMessage } from "@alfred/sync";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { clearPendingTurn, setPendingTurn } from "./pending-turn";
import { safeRandomId } from "./safe-random-id";
import { useReplicache } from "~/lib/replicache/context";
import { toast } from "~/lib/toast";
import { attachChatAssistantTiming, markChatSubmit, markChatTimingByUser } from "./timing";
import { uploadAttachment } from "./upload-attachments";
import { seedChatStream } from "./use-chat-stream";
import type { ChatAttachmentDescriptor } from "@alfred/contracts";
import { API_URL } from "~/lib/eden";

type SendResult =
  | { ok: true; runId: string | null; assistantMessageId: string }
  | { ok: false; reason: "busy"; blockingRunId: string | null }
  | { ok: false; reason: "error" | "empty" };

export type SendMessage = (
  threadId: string | undefined,
  text: string,
  tier?: ChatModelTier,
  files?: File[],
  /** Retry (ADR-0065): the server copies these stored attachments, so nothing uploads. */
  retryAttachmentIds?: string[],
  retryAttachmentMessageId?: string,
  /** Chosen in the artifact sidebar; never parsed from prose. */
  artifactTargetId?: string,
) => Promise<SendResult>;

/** The start acks fast; without a bound, a wedged connection waits minutes with no toast. */
const TURN_START_TIMEOUT_MS = 30_000;

/**
 * Upload files, show the message as a pending turn, start the turn over
 * `POST /api/chat/threads/:id/turn`, then mirror it into Replicache. The reply streams over SSE.
 */
export interface SendMessageOptions {
  /** Full autonomy picked before the thread exists. The server applies it only on create. */
  fullAutonomyForNewThread?: boolean | undefined;
}

export function useSendMessage(options: SendMessageOptions = {}): SendMessage {
  const fullAutonomyForNewThread = options.fullAutonomyForNewThread === true;
  const rep = useReplicache();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const navigate = useNavigate();
  const router = useRouter();

  return useCallback(
    async (
      threadId,
      text,
      tier,
      files,
      retryAttachmentIds,
      retryAttachmentMessageId,
      artifactTargetId,
    ) => {
      const content = text.trim();
      const pickedFiles = files ?? [];
      const retryIds = retryAttachmentIds ?? [];

      if (!rep || !userId) return { ok: false, reason: "error" } satisfies SendResult;

      if (
        isEmptyChatTurnInput({
          content,
          hasFiles: pickedFiles.length > 0,
          artifactTargetId,
          retryAttachmentIds: retryIds,
        })
      )
        return { ok: false, reason: "empty" } satisfies SendResult;

      const isNew = !threadId;
      const tid = threadId ?? safeRandomId("id");
      const userMessageId = safeRandomId("id");
      const now = new Date().toISOString();
      markChatSubmit({ threadId: tid, userMessageId, contentChars: content.length });

      // Upload first: the worker signs URLs from the object keys (ADR-0065).
      // A failed file is dropped with a toast; the rest of the turn goes on.
      let uploaded: ChatAttachmentDescriptor[] = [];

      if (pickedFiles.length > 0) {
        const uploadResults = await Promise.all(
          pickedFiles.map(async (file): Promise<ChatAttachmentDescriptor | null> => {
            try {
              return await uploadAttachment({
                threadId: tid,
                messageId: userMessageId,
                id: safeRandomId("id"),
                file,
              });
            } catch (err) {
              console.warn("[chat] attachment upload failed:", toMessage(err));
              toast.error(`Couldn't upload ${file.name}.`);

              return null;
            }
          }),
        );

        uploaded = uploadResults.filter((a): a is ChatAttachmentDescriptor => a !== null);
        uploaded = uploaded.map((a, position) => ({ ...a, position }));

        // Every file failed and nothing else is left to send.
        if (
          isEmptyChatTurnInput({
            content,
            hasFiles: uploaded.length > 0,
            artifactTargetId,
            retryAttachmentIds: retryIds,
          })
        )
          return { ok: false, reason: "empty" } satisfies SendResult;
      }

      const messageArgs = { id: userMessageId, threadId: tid, userId, content, createdAt: now };

      const attachmentArgs = uploaded.map((attachment) => ({
        id: attachment.id,
        messageId: userMessageId,
        threadId: tid,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        position: attachment.position,
        createdAt: now,
      }));

      // The bubble shows now. The Replicache mirror waits for the ack: a failed start cannot take back a pushed row.
      setPendingTurn({
        message: toSyncedUserMessage(messageArgs),
        attachments: attachmentArgs.map(toSyncedChatAttachment),
        ...(isNew ? { newThreadFullAutonomy: fullAutonomyForNewThread } : {}),
      });

      // A new chat opens its page at once. The mounted page picks up the seed when the ack comes.
      const opened = isNew
        ? navigate({ to: "/chat/$threadId", params: { threadId: tid } })
        : Promise.resolve();

      // No turn started. Drop the bubble and leave the new chat's page; the draft waits where it was.
      const abandon = async () => {
        clearPendingTurn(tid, userMessageId);
        await opened;

        if (isNew && router.state.location.pathname === `/chat/${tid}`) router.history.back();
      };

      let successPayload: { runId: string | null; assistantMessageId: string } | null = null;

      try {
        markChatTimingByUser(userMessageId, "turn_request_started");

        const res = await fetch(`${API_URL}/api/chat/threads/${tid}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            userMessageId,
            content,
            tier: tier ?? "standard",
            fullAutonomy: isNew && fullAutonomyForNewThread ? true : undefined,
            attachments: uploaded.length > 0 ? uploaded : undefined,
            retryAttachmentIds: retryIds.length > 0 ? retryIds : undefined,
            retryAttachmentMessageId:
              retryIds.length > 0 && retryAttachmentMessageId
                ? retryAttachmentMessageId
                : undefined,
            artifactTargetId,
          }),
          signal: AbortSignal.timeout(TURN_START_TIMEOUT_MS),
        });

        if (!res.ok) {
          // oxlint-disable-next-line alfred/no-swallowed-catch -- an unreadable error body only drops detail; the thrown error keeps the status
          const body = await res.text().catch(() => "");
          markChatTimingByUser(
            userMessageId,
            "turn_request_failed",
            { status: res.status, body },
            { summarize: true },
          );
          console.error("[chat] turn start failed:", res.status, body);
          toast.error("Couldn't send your message. Please try again.");
          await abandon();

          return { ok: false, reason: "error" } satisfies SendResult;
        }

        // oxlint-disable-next-line alfred/no-swallowed-catch -- an unreadable ack fails the parse below, and that path warns and uses the fallback id
        const payload = turnStartResponseSchema.safeParse(await res.json().catch(() => null));

        if (payload.success) {
          if (payload.data.outcome === "busy") {
            // Another turn is in flight, so no run started. The caller decides whether to queue it.
            markChatTimingByUser(
              userMessageId,
              "turn_request_thread_busy",
              { status: res.status, blockingRunId: payload.data.runId },
              { summarize: true },
            );
            await abandon();

            return {
              ok: false,
              reason: "busy",
              blockingRunId: payload.data.runId,
            } satisfies SendResult;
          }

          attachChatAssistantTiming({
            userMessageId,
            assistantMessageId: payload.data.assistantMessageId,
            runId: payload.data.runId,
            detail: { status: res.status },
          });
          successPayload = {
            runId: payload.data.runId,
            assistantMessageId: payload.data.assistantMessageId,
          };

          if (payload.data.runId) {
            seedChatStream(tid, {
              messageId: payload.data.assistantMessageId,
              runId: payload.data.runId,
            });
          }
        } else {
          markChatTimingByUser(
            userMessageId,
            "turn_request_ack_without_message_id",
            { status: res.status },
            { summarize: true },
          );
        }

        try {
          if (isNew) {
            await rep.mutate.chatThreadCreate({
              id: tid,
              userId,
              createdAt: now,
              fullAutonomy: fullAutonomyForNewThread,
            });
          }

          // Display only; the server already wrote the real rows. Replicache runs mutations in order.
          // Files before the message: the read hooks see both in one tick, so the pending bubble hands off whole.
          for (const attachment of attachmentArgs) {
            await rep.mutate.chatAttachmentCreate(attachment);
          }

          await rep.mutate.chatMessageCreate(messageArgs);
        } catch (err) {
          console.warn("[chat] local turn mirror failed:", toMessage(err));
        }
      } catch (err) {
        markChatTimingByUser(
          userMessageId,
          "turn_request_error",
          { error: toMessage(err) },
          { summarize: true },
        );
        console.error("[chat] turn start error:", toMessage(err));
        toast.error("Couldn't send your message. Please try again.");
        await abandon();

        return { ok: false, reason: "error" } satisfies SendResult;
      }

      // An unparseable 2xx ack is a contract break, but the turn did start. Log it and fall back.
      if (successPayload) {
        return {
          ok: true,
          runId: successPayload.runId,
          assistantMessageId: successPayload.assistantMessageId,
        } satisfies SendResult;
      }

      console.warn("[chat] turn start ack unparseable but Replicache staged; using fallback id");

      return { ok: true, runId: null, assistantMessageId: userMessageId } satisfies SendResult;
    },
    [rep, userId, navigate, router, fullAutonomyForNewThread],
  );
}
