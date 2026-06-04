import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewBriefingsRoute } from "./-preview-briefings/preview-briefings-route";

/**
 * In-app briefing surface (ADR-0049) — the canonical, scrollable record of the
 * day's briefing. Reverse-chronological timeline over the Replicache 30-day
 * window; read-only (the daily-briefing workflow is the sole writer). Renders
 * the child day-detail when one is matched.
 */
export const Route = createFileRoute("/briefings")({
  head: () => pageMeta({ title: "Briefings", path: "/briefings" }),
  component: PreviewBriefingsRoute,
});
