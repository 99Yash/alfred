import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewChatRoute = import.meta.env.DEV
  ? lazyRouteComponent(() => import("./-preview-chat/preview-chat-route"), "PreviewChatRoute")
  : () => null;

/** Fixture-filled chat design reference at `/preview/chat`. */
export const Route = createFileRoute("/preview/chat")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewChatRoute,
});
