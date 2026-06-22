import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ChatThreadRoute } from "./-chat/chat-thread-route";

/**
 * Canonical deep-link chat surface — `/chat/$threadId`.
 *
 * Pushes the URL thread id into ChatContext so the sidebar highlight picks
 * it up, then renders the same clean shell as `/chat`. Backend wiring
 * (real thread lookup, messages, composer submit) lands in m13.
 */
export const Route = createFileRoute("/chat/$threadId")({
  head: () => pageMeta({ title: "Chat", path: "/chat" }),
  component: ChatThreadRoute,
});
