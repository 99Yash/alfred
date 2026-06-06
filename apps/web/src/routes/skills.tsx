import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewSkillsRoute } from "./-preview-skills/preview-skills-route";

/**
 * App-grammar port of /skills.
 *
 * The dimension version subscribes to Replicache + POSTs through Eden
 * to create a draft. This preview uses fixture skills + a no-op CTA so
 * the visual language can be reviewed without auth or sync state.
 *
 * The list body lives in components/preview/skills so each component
 * file stays single-purpose (see `skills-page.tsx`, `skill-row.tsx`).
 */
export const Route = createFileRoute("/skills")({
  head: () => pageMeta({ title: "Skills", path: "/skills" }),
  component: PreviewSkillsRoute,
});
