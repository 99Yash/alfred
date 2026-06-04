import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewArtifactViewer } from "./-preview-library-artifact/preview-artifact-viewer";

/**
 * Visitors-now-grammar port of /library/$artifact.
 *
 * Fullscreen overlay viewer with the pages stacked vertically. The
 * dimension version uses Radix Dialog; this preview drops Dialog and
 * builds the overlay inline (same pattern as the share dialog on the
 * workflow detail page) so the chrome stays under visitors-now styling
 * control.
 *
 * Closes on ESC or backdrop click — both routes the user back to
 * `/library`.
 */
export const Route = createFileRoute("/library/$artifact")({
  head: () => pageMeta({ title: "Library" }),
  component: PreviewArtifactViewer,
});
