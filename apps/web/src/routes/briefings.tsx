import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { BriefingsRoute } from "./-briefings/briefings-route";

/** Briefings timeline (ADR-0049), read-only. Renders the day detail when matched. */
export const Route = createFileRoute("/briefings")({
  head: () => pageMeta({ title: "Briefings", path: "/briefings" }),
  component: BriefingsRoute,
});
