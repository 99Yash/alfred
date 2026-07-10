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

  useLayoutEffect(() => {
    setActiveThread(threadId);
  }, [threadId, setActiveThread]);

  // Title comes from the synced thread (the worker derives it from the opening
  // exchange; the turn endpoint seeds a placeholder before that lands). Stay
  // neutral while the subscription resolves so a deep link never presents an
  // existing conversation as a new one, even briefly.
  const title = thread?.title?.trim() || (loading ? "Chat" : "New chat");

  // Mirror the live thread title into the browser tab. The static route `head`
  // can't see Replicache subscriptions, so it seeds "Chat · Alfred"; this keeps
  // document.title in sync as the worker derives the real title post-turn.
  // No cleanup needed: navigating away re-runs the destination route's head.
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);

  return <ChatShell threadId={threadId} title={title} />;
}
