import { Outlet, useChildMatches } from "@tanstack/react-router";
import { useEffect } from "react";
import { formatPageTitle } from "~/lib/page-meta";
import { ChatShell } from "./chat-shell";

export function ChatRoute() {
  const hasChild = useChildMatches().length > 0;

  // Coming from a thread, the `/chat` head does not re-run, so the thread's title lingers.
  // Reset it here, not in a thread cleanup that could overwrite another route's title.
  useEffect(() => {
    if (!hasChild) document.title = formatPageTitle("Chat");
  }, [hasChild]);

  return hasChild ? <Outlet /> : <ChatShell threadId={undefined} title="New chat" />;
}
