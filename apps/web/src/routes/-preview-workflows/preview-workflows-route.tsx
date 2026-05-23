import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewWorkflowsPage } from "./preview-workflows-page";

export function PreviewWorkflowsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewWorkflowsPage />;
}
