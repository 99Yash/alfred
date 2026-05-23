import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewLibraryPage } from "./preview-library-page";

export function PreviewLibraryRoute() {
  const hasChild = useChildMatches().length > 0;
  return (
    <>
      <PreviewLibraryPage dimmed={hasChild} />
      {hasChild ? <Outlet /> : null}
    </>
  );
}
