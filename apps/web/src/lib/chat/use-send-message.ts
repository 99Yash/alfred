import { toMessage, turnKickResponseSchema, type ChatModelTier } from "@alfred/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { toast } from "~/lib/toast";
import { attachChatAssistantTiming, markChatSubmit, markChatTimingByUser } from "./timing";
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
  retryAttachmentMessageId?: string,
  /** Structured target selected by the artifact sidebar; never parsed from prose. */
  artifactTargetId?: string,
) => Promise<boolean>;

/**
 * The kick just stages the message + enqueues the run (the reply streams back
 * over SSE), so it should ack in well under a second. Bound it anyway: without
 * a signal a wedged connection leaves the optimistic UI waiting on the
 * browser's default network timeout (minutes), with no error toast. Mirrors the
 * transcription path in `turn-controls.ts`.
 */
const TURN_KICK_TIMEOUT_MS = 30_000;

/**
 * Send a chat turn. Uploads any files, kicks the agent over
 * `POST /api/chat/threads/:id/turn` (which durably upserts the user message),
 * then mirrors the accepted turn into Replicache for immediate local display.
 * The agent's reply streams back over SSE (see `useChatStream`).
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
      if (!rep || !userId) return false;
      // A turn needs text, at least one fresh file, or at least one re-attached
      // file (image-only sends — and image-only retries — are valid).
      if (content.length === 0 && pickedFiles.length === 0 && retryIds.length === 0) return false;

      const isNew = !threadId;
      const tid = threadId ?? crypto.randomUUID();
      const userMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      markChatSubmit({ threadId: tid, userMessageId, contentChars: content.length });

      // Upload the bytes to the bucket before staging the message. The durable
      // transcript stores object keys; the worker signs fresh read URLs from
      // those keys when a model step starts, so the object must exist before the
      // run is kicked. A per-file failure drops just that file (toast); the rest
      // of the turn still goes through. (ADR-0065)
      let uploaded: UploadedAttachment[] = [];
      if (pickedFiles.length > 0) {
        const uploadResults = await Promise.all(
          pickedFiles.map(async (file): Promise<UploadedAttachment | null> => {
            try {
              return await uploadAttachment({
                threadId: tid,
                messageId: userMessageId,
                id: crypto.randomUUID(),
                file,
              });
            } catch (err) {
              console.warn("[chat] attachment upload failed:", toMessage(err));
              toast.error(`Couldn't upload ${file.name}.`);
              return null;
            }
          }),
        );
        uploaded = uploadResults.filter((a): a is UploadedAttachment => a !== null);
        uploaded = uploaded.map((a, position) => ({ ...a, position }));
        // Every file failed and there's no text or re-attached file — nothing to send.
        if (uploaded.length === 0 && content.length === 0 && retryIds.length === 0) return false;
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
            retryAttachmentMessageId:
              retryIds.length > 0 && retryAttachmentMessageId
                ? retryAttachmentMessageId
                : undefined,
            artifactTargetId,
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
          return false;
        }

        const payload = turnKickResponseSchema.safeParse(await res.json().catch(() => null));
        if (payload.success) {
          if (payload.data.outcome === "busy") {
            // The thread already has a turn in flight (#488). No run was created
            // for this message. Keep the composer's text and attachments (return
            // false → the composer does NOT clear) so the user can retry once
            // the in-flight reply finishes; don't surface it as a failure.
            markChatTimingByUser(
              userMessageId,
              "turn_request_thread_busy",
              { status: res.status, blockingRunId: payload.data.runId },
              { summarize: true },
            );
            return false;
          }
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
          // Local display patch only: the HTTP route has already verified the
          // bucket object and inserted the canonical attachment rows. Replicache
          // serializes write mutations internally, so preserve explicit order
          // instead of presenting this as concurrent work.
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
        console.error("[chat] turn kick error:", toMessage(err));
        toast.error("Couldn't send your message. Please try again.");
        return false;
      }
      return true;
    },
    [rep, session?.user?.id, navigate],
  );
}
