import { Outlet, useChildMatches } from "@tanstack/react-router";
import { LibraryPage } from "./library-page";

export function LibraryRoute() {
  const hasChild = useChildMatches().length > 0;
  return (
    <>
      <LibraryPage dimmed={hasChild} />
      {hasChild ? <Outlet /> : null}
    </>
  );
}
