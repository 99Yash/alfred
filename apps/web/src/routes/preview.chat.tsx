import { createFileRoute } from "@tanstack/react-router";
import { PreviewChatRoute } from "./-preview-chat/preview-chat-route";

/**
 * Design reference for the chat shell at `/preview/chat`.
 *
 * Fixture-rich (fake threads, conversation samples, right-rail meetings/
 * inbox/todos, weather chip, …) — useful for iterating on the chat UI
 * without backend data. The real `/chat` route is intentionally fixture-
 * free; backend wiring lands in m13.
 */
export const Route = createFileRoute("/preview/chat")({
  component: PreviewChatRoute,
});
