import { useParams } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import { useChatContext } from "~/components/chat-context";
import { formatPageTitle } from "~/lib/page-meta";
import { useChatThread } from "~/lib/replicache/use-chat";
import { ChatShell } from "./chat-shell";

export function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });
  const { setActiveThread } = useChatContext();
  const { thread, loading } = useChatThread(threadId);

  // Clear on unmount, or bare `/chat` keeps the old thread highlighted. Mirrors the preview route.
  useLayoutEffect(() => {
    setActiveThread(threadId);

    return () => setActiveThread("");
  }, [threadId, setActiveThread]);

  // Stay neutral while loading, so a deep link never shows as a new chat.
  const title = thread?.title?.trim() || (loading ? "Chat" : "New chat");

  // The route `head` cannot see Replicache, so sync the tab title here. Navigation re-runs head.
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);

  return <ChatShell threadId={threadId} title={title} />;
}
