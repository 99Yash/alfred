import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewLibraryPage } from "./-preview-library/preview-library-page";

/**
 * Visitors-now-grammar port of /library.
 *
 * Same data + filter behavior as the dimension page (Type popover +
 * All/Favourites pill + search) over the fixture `LIBRARY_ARTIFACTS`.
 * Card cover preview reuses `ArtifactPageFrame` so the rendered HTML
 * pages from the archive still drive the thumbnail.
 *
 * The detail viewer (`preview.library.$artifact.tsx`) renders on top of
 * the list as a fullscreen overlay — the dimension version uses Radix
 * Dialog; we use a simple fixed overlay to keep the styling under our
 * control. When a child route is active the list dims and stops
 * accepting pointer events.
 */
export const Route = createFileRoute("/preview/library")({
  component: PreviewLibraryRoute,
});

function PreviewLibraryRoute() {
  const hasChild = useChildMatches().length > 0;
  return (
    <>
      <PreviewLibraryPage dimmed={hasChild} />
      {hasChild ? <Outlet /> : null}
    </>
  );
}
