import { Outlet, useChildMatches } from "@tanstack/react-router";
import { WorkflowsPage } from "./workflows-page";

export function WorkflowsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <WorkflowsPage />;
}
