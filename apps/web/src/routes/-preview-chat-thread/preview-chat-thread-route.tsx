import { useEffect } from "react";
import { useChatContext } from "~/components/preview/chat-context";
import { PreviewChatPage } from "~/routes/-preview-chat/preview-chat-page";
import { Route } from "~/routes/preview.chat.$threadId";

export function PreviewChatThreadRoute() {
  const { threadId } = Route.useParams();
  const { activeThread, setActiveThread } = useChatContext();

  useEffect(() => {
    if (threadId !== activeThread) {
      setActiveThread(threadId);
    }
  }, [threadId, activeThread, setActiveThread]);

  return <PreviewChatPage />;
}
