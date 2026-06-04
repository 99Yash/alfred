import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { useChatContext } from "~/components/chat-context";
import { ChatShell } from "./-chat/chat-shell";

/**
 * Canonical chat surface — `/chat`.
 *
 * Clean shell only: top bar, empty conversation area, composer placeholder.
 * No fixture threads, messages, or right-rail content — backend wiring lands
 * in m13. The fixture-rich design reference lives at `/preview/chat`.
 *
 * Renders `<Outlet />` when a `/chat/$threadId` child is matched so the deep
 * link gets its own component, mirroring the dimension chat route's pattern.
 */
export const Route = createFileRoute("/chat")({
  head: () => pageMeta({ title: "Chat" }),
  component: ChatRoute,
});

function ChatRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <ChatIndex />;
}

function ChatIndex() {
  const { activeThread } = useChatContext();
  return <ChatShell threadId={activeThread} title="New chat" />;
}
