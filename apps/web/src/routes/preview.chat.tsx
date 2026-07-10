import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewChatRoute = import.meta.env.DEV
  ? lazyRouteComponent(() => import("./-preview-chat/preview-chat-route"), "PreviewChatRoute")
  : () => null;

/**
 * Design reference for the chat shell at `/preview/chat`.
 *
 * Fixture-rich (fake threads, conversation samples, right-rail meetings/
 * inbox/todos, weather chip, …) — useful for iterating on the chat UI
 * without backend data. The real `/chat` route is intentionally fixture-
 * free; backend wiring lands in m13.
 */
export const Route = createFileRoute("/preview/chat")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewChatRoute,
});
