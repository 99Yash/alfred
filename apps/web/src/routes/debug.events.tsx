import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { DebugEventsPage } from "./-debug/debug-events-page";

export const Route = createFileRoute("/debug/events")({
  head: () => pageMeta({ title: "Debug events", path: "/debug/events" }),
  component: DebugEventsPage,
});
