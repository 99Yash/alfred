import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewChatThreadRoute = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-chat-thread/preview-chat-thread-route"),
      "PreviewChatThreadRoute",
    )
  : () => null;

/** Fixture deep link; the URL thread id goes into ChatContext for the sidebar. */
export const Route = createFileRoute("/preview/chat/$threadId")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewChatThreadRoute,
});
