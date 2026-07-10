import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ArtifactViewer } from "./-library/artifact-viewer";

export const Route = createFileRoute("/library/$artifact")({
  head: () => pageMeta({ title: "Library", path: "/library" }),
  component: ArtifactViewer,
});
