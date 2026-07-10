import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewChatThreadRoute = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-chat-thread/preview-chat-thread-route"),
      "PreviewChatThreadRoute",
    )
  : () => null;

/**
 * Design-reference deep link — `/preview/chat/$threadId`. Same fixture
 * shell as `/preview/chat`; the threadId from the URL gets pushed into
 * ChatContext so the sidebar highlight + page title pick it up.
 */
export const Route = createFileRoute("/preview/chat/$threadId")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewChatThreadRoute,
});
