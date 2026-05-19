import { createFileRoute, useParams } from "@tanstack/react-router";
import { DimensionChatThread } from "~/components/dimension-chat-thread";

export const Route = createFileRoute("/chat/$threadId")({
  component: ChatThreadRoute,
});

function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });

  return <DimensionChatThread showArtifactPanel={threadId === "artifact-preview"} />;
}
