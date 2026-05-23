import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewSkillsPage } from "~/components/preview/skills/skills-page";

export function PreviewSkillsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewSkillsPage />;
}
