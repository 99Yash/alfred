import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ChatThreadRoute } from "./-chat/chat-thread-route";

export const Route = createFileRoute("/chat/$threadId")({
  head: () => pageMeta({ title: "Chat", path: "/chat" }),
  component: ChatThreadRoute,
});
