import { createFileRoute } from "@tanstack/react-router";
import { PreviewChatThreadRoute } from "./-preview-chat-thread/preview-chat-thread-route";

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
