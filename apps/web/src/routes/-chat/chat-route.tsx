import { Outlet, useChildMatches } from "@tanstack/react-router";
import { useEffect } from "react";
import { formatPageTitle } from "~/lib/page-meta";
import { ChatShell } from "./chat-shell";

export function ChatRoute() {
  const hasChild = useChildMatches().length > 0;

  // Own the tab title for the bare `/chat` (new chat) surface. The `/chat`
  // route's static `head` seeds "Chat · Alfred", but when landing here from a
  // thread that head doesn't re-run (the parent match was already active) and
  // `ChatThreadRoute`'s imperative `document.title` lingers. Restoring it here
  // — rather than in a thread-route cleanup — keeps us from clobbering a
  // different destination route's title, since this only writes while `/chat`
  // is the active route.
  useEffect(() => {
    if (!hasChild) document.title = formatPageTitle("Chat");
  }, [hasChild]);

  return hasChild ? <Outlet /> : <ChatShell threadId={undefined} title="New chat" />;
}
