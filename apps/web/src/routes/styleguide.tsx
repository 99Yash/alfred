import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { StyleguidePage } from "./-styleguide/styleguide-page";

export const Route = createFileRoute("/styleguide")({
  head: () => pageMeta({ title: "Styleguide", path: "/styleguide" }),
  component: StyleguidePage,
});
