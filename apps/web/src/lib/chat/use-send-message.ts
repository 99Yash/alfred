import type { ChatModelTier } from "@alfred/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { toast } from "~/lib/toast";
import { attachChatAssistantTiming, markChatSubmit, markChatTimingByUser } from "./timing";
import { toMessage } from "@alfred/contracts";
import { uploadAttachment, type UploadedAttachment } from "./upload-attachments";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * The canonical `ChatModelTier` from `@alfred/contracts` (server-side it lives
 * in `@alfred/ai`, which can't enter the web bundle). Aliased to `ChatTier` for
 * the existing call sites.
 */
export type ChatTier = ChatModelTier;

export type SendMessage = (
  threadId: string | undefined,
  text: string,
  tier?: ChatTier,
  files?: File[],
  /**
   * Faithful retry (ADR-0065): source attachment ids from the prior user
   * message to re-attach. The bytes are already in the bucket, so the client
   * uploads nothing — the turn endpoint copies them under the new message's
   * keys. Mutually exclusive with `files` in practice (retry carries no fresh
   * picks).
   */
  retryAttachmentIds?: string[],
) => Promise<void>;

const turnKickResponseSchema = z.object({
  runId: z.string().nullable(),
  assistantMessageId: z.string().min(1),
});

/**
 * The kick just stages the message + enqueues the run (the reply streams back
 * over SSE), so it should ack in well under a second. Bound it anyway: without
 * a signal a wedged connection leaves the optimistic UI waiting on the
 * browser's default network timeout (minutes), with no error toast. Mirrors the
 * transcription path in `turn-controls.ts`.
 */
const TURN_KICK_TIMEOUT_MS = 30_000;

/**
 * Send a chat turn. Persists the user message via Replicache (optimistic +
 * multi-device), kicks the agent over `POST /api/chat/threads/:id/turn`, and
 * — for a brand-new chat — mints the thread id and navigates to its deep link.
 * The agent's reply streams back over SSE (see `useChatStream`).
 */
export function useSendMessage(): SendMessage {
  const rep = useReplicache();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const navigate = useNavigate();

  return useCallback(
    async (threadId, text, tier, files, retryAttachmentIds) => {
      const content = text.trim();
      const pickedFiles = files ?? [];
      const retryIds = retryAttachmentIds ?? [];
      if (!rep || !userId) return;
      // A turn needs text, at least one fresh file, or at least one re-attached
      // file (image-only sends — and image-only retries — are valid).
      if (content.length === 0 && pickedFiles.length === 0 && retryIds.length === 0) return;

      const isNew = !threadId;
      const tid = threadId ?? crypto.randomUUID();
      const userMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      markChatSubmit({ threadId: tid, userMessageId, contentChars: content.length });

      // Upload the bytes to the bucket before staging the message — the turn's
      // worker reads each attachment's presigned URL, so the object must exist
      // by the time the run starts. A per-file failure drops just that file
      // (toast); the rest of the turn still goes through. (ADR-0065)
      const uploaded: UploadedAttachment[] = [];
      if (pickedFiles.length > 0) {
        await Promise.all(
          pickedFiles.map(async (file) => {
            try {
              uploaded.push(
                await uploadAttachment({
                  threadId: tid,
                  messageId: userMessageId,
                  id: crypto.randomUUID(),
                  file,
                }),
              );
            } catch (err) {
              console.error("[chat] attachment upload failed:", err);
              toast.error(`Couldn't upload ${file.name}.`);
            }
          }),
        );
        // Every file failed and there's no text or re-attached file — nothing to send.
        if (uploaded.length === 0 && content.length === 0 && retryIds.length === 0) return;
      }

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
      // Optimistically record each uploaded attachment so the image renders in
      // its bubble immediately; the server mutator persists the canonical row.
      for (const a of uploaded) {
        await rep.mutate.chatAttachmentCreate({
          id: a.id,
          messageId: userMessageId,
          threadId: tid,
          name: a.name,
          mime: a.mime,
          size: a.size,
          createdAt: now,
        });
      }

      if (isNew) {
        void navigate({ to: "/chat/$threadId", params: { threadId: tid } });
      }

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
            // Faithful retry: the server copies these source objects under the
            // new message's keys and writes the rows (which sync back via pull).
            retryAttachmentIds: retryIds.length > 0 ? retryIds : undefined,
          }),
          signal: AbortSignal.timeout(TURN_KICK_TIMEOUT_MS),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          markChatTimingByUser(
            userMessageId,
            "turn_request_failed",
            { status: res.status, body },
            { summarize: true },
          );
          console.error("[chat] turn kick failed:", res.status, body);
          toast.error("Couldn't send your message. Please try again.");
          return;
        }

        const payload = turnKickResponseSchema.safeParse(await res.json().catch(() => null));
        if (payload.success) {
          attachChatAssistantTiming({
            userMessageId,
            assistantMessageId: payload.data.assistantMessageId,
            runId: payload.data.runId,
            detail: { status: res.status },
          });
        } else {
          markChatTimingByUser(
            userMessageId,
            "turn_request_ack_without_message_id",
            { status: res.status },
            { summarize: true },
          );
        }
      } catch (err) {
        markChatTimingByUser(
          userMessageId,
          "turn_request_error",
          { error: toMessage(err) },
          { summarize: true },
        );
        console.error("[chat] turn kick error:", err);
        toast.error("Couldn't send your message. Please try again.");
      }
    },
    [rep, userId, navigate],
  );
}
