import { Outlet, useChildMatches } from "@tanstack/react-router";
import { SkillsPage } from "~/components/skills/skills-page";

export function SkillsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <SkillsPage />;
}
