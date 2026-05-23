import { createFileRoute } from "@tanstack/react-router";
import { PreviewSkillDetailPage } from "./-preview-skill-detail/preview-skill-detail-page";

/**
 * Visitors-now-grammar port of /skills/$slug.
 *
 * The detail surface is two tabs:
 *   • Learn   — prompt textarea + Re-learn CTA + Memory Update card
 *   • History — list of runs with VsPill statuses + revision IDs
 *
 * Fixture-driven so the page can be reviewed in isolation. Re-learn
 * is a stateful no-op that toggles a "learning…" banner for ~1.5s,
 * matching the active-run state in the dimension page without
 * actually starting a job.
 */
export const Route = createFileRoute("/preview/skills/$slug")({
  component: PreviewSkillDetailPage,
});
