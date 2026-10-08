import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { BriefingDetailPage } from "./-briefings/briefing-detail-page";

/** One day's briefing (ADR-0049); `$date` is `YYYY-MM-DD`. */
export const Route = createFileRoute("/briefings/$date")({
  head: ({ params }) =>
    pageMeta({
      title: `Briefing · ${params.date}`,
      path: `/briefings/${encodeURIComponent(params.date)}`,
    }),
  component: BriefingDetailPage,
});
