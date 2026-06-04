import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewBriefingDetailPage } from "./-preview-briefings/preview-briefing-detail-page";

/**
 * A single day's briefing detail (ADR-0049). The `$date` param is a human
 * `YYYY-MM-DD` key; the page prefix-scans `briefing/{date}/` and renders the
 * morning and evening slots stacked.
 */
export const Route = createFileRoute("/briefings/$date")({
  head: ({ params }) => pageMeta({ title: `Briefing · ${params.date}` }),
  component: PreviewBriefingDetailPage,
});
