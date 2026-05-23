import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useChatContext } from "~/components/preview/chat-context";
import { PreviewChatPage } from "./preview.chat";

/**
 * Deep-link variant of `/preview/chat`.
 *
 * Same shell as the index route — the only difference is that the
 * thread id comes from the URL instead of defaulting to the
 * morning-brief thread. The id is pushed into `ChatContext` so the
 * existing `<PreviewChatPage />` (which reads from context) and the
 * sidebar's active-row highlight pick it up without any other change.
 *
 * Threads not in the local fixture set still navigate here; the page
 * gracefully falls back to "New chat" via `findThread` returning
 * undefined.
 */
export const Route = createFileRoute("/preview/chat/$threadId")({
  component: PreviewChatThreadRoute,
});

function PreviewChatThreadRoute() {
  const { threadId } = Route.useParams();
  const { activeThread, setActiveThread } = useChatContext();

  useEffect(() => {
    if (threadId !== activeThread) {
      setActiveThread(threadId);
    }
  }, [threadId, activeThread, setActiveThread]);

  return <PreviewChatPage />;
}
