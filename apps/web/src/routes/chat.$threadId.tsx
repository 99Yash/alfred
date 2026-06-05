import { createFileRoute, useParams } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { useEffect } from "react";
import { useChatContext } from "~/components/chat-context";
import { useChatThread } from "~/lib/replicache/use-chat";
import { ChatShell } from "./-chat/chat-shell";

/**
 * Canonical deep-link chat surface — `/chat/$threadId`.
 *
 * Pushes the URL thread id into ChatContext so the sidebar highlight picks
 * it up, then renders the same clean shell as `/chat`. Backend wiring
 * (real thread lookup, messages, composer submit) lands in m13.
 */
export const Route = createFileRoute("/chat/$threadId")({
  head: () => pageMeta({ title: "Chat", path: "/chat" }),
  component: ChatThreadRoute,
});

function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });
  const { activeThread, setActiveThread } = useChatContext();
  const thread = useChatThread(threadId);

  useEffect(() => {
    if (threadId !== activeThread) setActiveThread(threadId);
  }, [threadId, activeThread, setActiveThread]);

  // Title comes from the synced thread (the worker derives it from the opening
  // exchange; the turn endpoint seeds a placeholder before that lands). Falls
  // back to "New chat" before the thread row has synced.
  const title = thread?.title?.trim() || "New chat";
  return <ChatShell threadId={threadId} title={title} />;
}
