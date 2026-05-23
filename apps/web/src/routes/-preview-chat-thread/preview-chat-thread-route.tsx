import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useChatContext } from "~/components/chat-context";
import { PreviewChatPage } from "~/routes/-preview-chat/preview-chat-page";

export function PreviewChatThreadRoute() {
  const { threadId } = useParams({ from: "/preview/chat/$threadId" });
  const { activeThread, setActiveThread } = useChatContext();

  useEffect(() => {
    if (threadId !== activeThread) {
      setActiveThread(threadId);
    }
  }, [threadId, activeThread, setActiveThread]);

  return <PreviewChatPage />;
}
