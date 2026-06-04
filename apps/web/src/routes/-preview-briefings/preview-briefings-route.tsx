import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewBriefingsPage } from "./preview-briefings-page";

export function PreviewBriefingsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewBriefingsPage />;
}
