import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";

const DebugEventsPage = import.meta.env.DEV
  ? lazyRouteComponent(() => import("./-debug/debug-events-page"), "DebugEventsPage")
  : () => null;

export const Route = createFileRoute("/debug/events")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  head: () => pageMeta({ title: "Debug events", path: "/debug/events" }),
  component: DebugEventsPage,
});
