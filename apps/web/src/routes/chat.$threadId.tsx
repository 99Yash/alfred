import { createFileRoute, useParams } from "@tanstack/react-router";
import { DimensionChatThread } from "~/components/dimension-chat-thread";

export const Route = createFileRoute("/chat/$threadId")({
  component: ChatThreadRoute,
});

function ChatThreadRoute() {
  const { threadId } = useParams({ from: "/chat/$threadId" });
  const search = new URLSearchParams(window.location.search);
  const state = search.get("state");
  const artifact = search.get("artifact");
  const artifactState = search.get("artifactState");

  return (
    <DimensionChatThread
      artifactState={
        artifactState === "empty" || artifactState === "generating" ? artifactState : "completed"
      }
      previewState={
        state === "streaming" ||
        state === "active-tool" ||
        state === "all-expanded" ||
        state === "rich-content"
          ? state
          : "completed"
      }
      showArtifactPanel={threadId === "artifact-preview" || artifact === "1"}
    />
  );
}
