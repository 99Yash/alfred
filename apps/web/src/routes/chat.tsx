import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ChatRoute } from "./-chat/chat-route";

export const Route = createFileRoute("/chat")({
  head: () => pageMeta({ title: "Chat", path: "/chat" }),
  component: ChatRoute,
});
