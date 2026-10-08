import {
  isEmptyChatTurnInput,
  toMessage,
  turnStartResponseSchema,
  type ChatModelTier,
} from "@alfred/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { toast } from "~/lib/toast";
import { attachChatAssistantTiming, markChatSubmit, markChatTimingByUser } from "./timing";
import { uploadAttachment } from "./upload-attachments";
import type { ChatAttachmentDescriptor } from "@alfred/contracts";
import { API_URL } from "~/lib/eden";

export type SendResult =
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

function safeRandomId(): string {
  if (typeof crypto === "undefined")
    return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return crypto.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Upload files, start the turn over `POST /api/chat/threads/:id/turn`, then mirror
 * it into Replicache for instant display. The reply streams over SSE.
 */
export function useSendMessage(): SendMessage {
  const rep = useReplicache();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const navigate = useNavigate();

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
      const tid = threadId ?? safeRandomId();
      const userMessageId = safeRandomId();
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
                id: safeRandomId(),
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
          const body = await res.text().catch(() => "");
          markChatTimingByUser(
            userMessageId,
            "turn_request_failed",
            { status: res.status, body },
            { summarize: true },
          );
          console.error("[chat] turn start failed:", res.status, body);
          toast.error("Couldn't send your message. Please try again.");

          return { ok: false, reason: "error" } satisfies SendResult;
        }

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
            await rep.mutate.chatThreadCreate({ id: tid, userId, createdAt: now });
          }

          await rep.mutate.chatMessageCreate({
            id: userMessageId,
            threadId: tid,
            userId,
            content,
            createdAt: now,
          });

          // Display only; the server already wrote the real rows. Replicache runs mutations in order.
          for (const attachment of uploaded) {
            await rep.mutate.chatAttachmentCreate({
              id: attachment.id,
              messageId: userMessageId,
              threadId: tid,
              name: attachment.name,
              mime: attachment.mime,
              size: attachment.size,
              position: attachment.position,
              createdAt: now,
            });
          }
        } catch (err) {
          console.warn("[chat] local turn mirror failed:", toMessage(err));
        }

        if (isNew) {
          void navigate({ to: "/chat/$threadId", params: { threadId: tid } });
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

      console.warn("[chat] turn start ack unparseable but Replicache staged — using fallback id");

      return { ok: true, runId: null, assistantMessageId: userMessageId } satisfies SendResult;
    },
    [rep, session?.user?.id, navigate],
  );
}
