import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { LibraryRoute } from "./-library/library-route";

export const Route = createFileRoute("/library")({
  head: () => pageMeta({ title: "Library", path: "/library" }),
  component: LibraryRoute,
});
