import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewSkillsPage } from "~/components/preview/skills/skills-page";

/**
 * Visitors-now-grammar port of /skills.
 *
 * The dimension version subscribes to Replicache + POSTs through Eden
 * to create a draft. This preview uses fixture skills + a no-op CTA so
 * the visual language can be reviewed without auth or sync state.
 *
 * The list body lives in components/preview/skills so each component
 * file stays single-purpose (see `skills-page.tsx`, `skill-row.tsx`).
 */
export const Route = createFileRoute("/preview/skills")({
  component: PreviewSkillsRoute,
});

function PreviewSkillsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewSkillsPage />;
}
