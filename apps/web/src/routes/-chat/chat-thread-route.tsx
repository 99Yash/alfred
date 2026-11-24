import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { useChatContext } from "~/components/chat-context";
import { clearPendingTurn, usePendingTurn } from "~/lib/chat/pending-turn";
import { formatPageTitle } from "~/lib/page-meta";
import { useChatThread } from "~/lib/replicache/use-chat";
import { ChatShell } from "./chat-shell";

export function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });
  const { setActiveThread } = useChatContext();
  const { thread, loading, missing } = useChatThread(threadId);
  const navigate = useNavigate();
  const pendingTurn = usePendingTurn(threadId);

  // The last thread that this page showed with a row. Set during render, like a reset on a new id.
  const [shownId, setShownId] = useState<string | null>(null);

  if (thread && shownId !== threadId) setShownId(threadId);

  // The store has no row: the thread is deleted (here or on another device), or the id has no
  // thread. A send to it gets a 404, and a cached reply stays because its synced row never comes.
  // A new chat has no row until its first turn syncs, so its pending turn keeps the page. A row
  // that this page showed and then lost is deleted, even with a pending turn.
  const gone = missing && (shownId === threadId || pendingTurn === null);
  const pendingMessageId = pendingTurn?.message.id;

  // Clear on unmount, or bare `/chat` keeps the old thread highlighted. Mirrors the preview route.
  useLayoutEffect(() => {
    setActiveThread(threadId);

    return () => setActiveThread("");
  }, [threadId, setActiveThread]);

  // Replace the entry, so Back does not open the deleted thread again. The pending turn of a
  // deleted thread never syncs, so drop it here.
  useEffect(() => {
    if (!gone) return;

    if (pendingMessageId) clearPendingTurn(threadId, pendingMessageId);
    void navigate({ to: "/chat", replace: true });
  }, [gone, navigate, pendingMessageId, threadId]);

  // Stay neutral while loading, so a deep link never shows as a new chat.
  const title = thread?.title?.trim() || (loading ? "Chat" : "New chat");

  // The route `head` cannot see Replicache, so sync the tab title here. Navigation re-runs head.
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);

  if (gone) return null;

  return <ChatShell threadId={threadId} thread={thread} title={title} />;
}
