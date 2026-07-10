import { useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { useChatContext } from "~/components/chat-context";
import { PreviewChatPage } from "~/routes/-preview-chat/preview-chat-page";

export function PreviewChatThreadRoute() {
  const { threadId } = useParams({ from: "/preview/chat/$threadId" });
  const { setActiveThread } = useChatContext();

  useLayoutEffect(() => {
    setActiveThread(threadId);
    return () => setActiveThread("");
  }, [threadId, setActiveThread]);

  return <PreviewChatPage />;
}
