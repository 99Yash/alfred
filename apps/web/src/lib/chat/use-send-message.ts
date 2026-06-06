import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { callToast } from "~/lib/toast";
import { authClient } from "~/lib/auth-client";
import { useReplicache } from "~/lib/replicache/context";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export type SendMessage = (threadId: string | undefined, text: string) => Promise<void>;

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
    async (threadId, text) => {
      const content = text.trim();
      if (!rep || !userId || content.length === 0) return;

      const isNew = !threadId;
      const tid = threadId ?? crypto.randomUUID();
      const userMessageId = crypto.randomUUID();
      const now = new Date().toISOString();

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
        const res = await fetch(`${API_URL}/api/chat/threads/${tid}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ userMessageId, content }),
        });
        if (!res.ok) {
          console.error("[chat] turn kick failed:", res.status, await res.text().catch(() => ""));
          callToast({ message: "Couldn't send your message. Please try again.", type: "danger" });
        }
      } catch (err) {
        console.error("[chat] turn kick error:", err);
        callToast({ message: "Couldn't send your message. Please try again.", type: "danger" });
      }
    },
    [rep, userId, navigate],
  );
}
