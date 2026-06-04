import { createFileRoute, useParams } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { useEffect } from "react";
import { useChatContext } from "~/components/chat-context";
import { ChatShell } from "./-chat/chat-shell";

/**
 * Canonical deep-link chat surface — `/chat/$threadId`.
 *
 * Pushes the URL thread id into ChatContext so the sidebar highlight picks
 * it up, then renders the same clean shell as `/chat`. Backend wiring
 * (real thread lookup, messages, composer submit) lands in m13.
 */
export const Route = createFileRoute("/chat/$threadId")({
  head: () => pageMeta({ title: "Chat" }),
  component: ChatThreadRoute,
});

function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });
  const { activeThread, setActiveThread } = useChatContext();

  useEffect(() => {
    if (threadId !== activeThread) setActiveThread(threadId);
  }, [threadId, activeThread, setActiveThread]);

  return <ChatShell threadId={threadId} title={threadId} />;
}
