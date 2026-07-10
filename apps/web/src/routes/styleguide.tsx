import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";

const StyleguidePage = import.meta.env.DEV
  ? lazyRouteComponent(() => import("./-styleguide/styleguide-page"), "StyleguidePage")
  : () => null;

export const Route = createFileRoute("/styleguide")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  head: () => pageMeta({ title: "Styleguide", path: "/styleguide" }),
  component: StyleguidePage,
});
