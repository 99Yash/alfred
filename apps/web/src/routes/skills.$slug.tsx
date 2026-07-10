import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SkillDetailPage } from "./-skills/detail/skill-detail-page";
export const Route = createFileRoute("/skills/$slug")({
  head: ({ params }) =>
    pageMeta({
      title: `${params.slug} · Skills`,
      path: `/skills/${encodeURIComponent(params.slug)}`,
    }),
  component: SkillDetailPage,
});
