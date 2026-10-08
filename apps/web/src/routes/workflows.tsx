import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { WorkflowsRoute } from "./-workflows/workflows-route";

/** Workflows list: built-ins, each with a small preview of what it produces, then the user's own. */
export const Route = createFileRoute("/workflows")({
  head: () => pageMeta({ title: "Workflows", path: "/workflows" }),
  component: WorkflowsRoute,
});
