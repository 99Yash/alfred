import type { ChatModelTier } from "@alfred/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { toast } from "~/lib/toast";
import { attachChatAssistantTiming, markChatSubmit, markChatTimingByUser } from "./timing";
import { toMessage } from "@alfred/contracts";

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
    async (threadId, text, tier) => {
      const content = text.trim();
      if (!rep || !userId || content.length === 0) return;

      const isNew = !threadId;
      const tid = threadId ?? crypto.randomUUID();
      const userMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      markChatSubmit({ threadId: tid, userMessageId, contentChars: content.length });

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

      if (isNew) {
        void navigate({ to: "/chat/$threadId", params: { threadId: tid } });
      }

      try {
        markChatTimingByUser(userMessageId, "turn_request_started");
        const res = await fetch(`${API_URL}/api/chat/threads/${tid}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ userMessageId, content, tier: tier ?? "standard" }),
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
