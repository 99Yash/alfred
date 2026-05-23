import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewChatPage } from "./preview-chat-page";

export function PreviewChatRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewChatPage />;
}
