import { Outlet, useChildMatches } from "@tanstack/react-router";
import { ChatShell } from "./chat-shell";

export function ChatRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <ChatShell threadId={undefined} title="New chat" />;
}
