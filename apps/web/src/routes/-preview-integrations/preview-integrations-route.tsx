import { Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewIntegrationsPage } from "./preview-integrations-page";

export function PreviewIntegrationsRoute() {
  // Defer to the child route when one is matched (e.g. /preview/integrations/$provider).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewIntegrationsPage />;
}
