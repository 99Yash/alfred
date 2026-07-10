import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SkillsRoute } from "./-skills/skills-route";

export const Route = createFileRoute("/skills")({
  head: () => pageMeta({ title: "Skills", path: "/skills" }),
  component: SkillsRoute,
});
