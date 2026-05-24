import { createFileRoute } from "@tanstack/react-router";
import { PreviewChatThreadRoute } from "./-preview-chat-thread/preview-chat-thread-route";

/**
 * Design-reference deep link — `/preview/chat/$threadId`. Same fixture
 * shell as `/preview/chat`; the threadId from the URL gets pushed into
 * ChatContext so the sidebar highlight + page title pick it up.
 */
export const Route = createFileRoute("/preview/chat/$threadId")({
  component: PreviewChatThreadRoute,
});
