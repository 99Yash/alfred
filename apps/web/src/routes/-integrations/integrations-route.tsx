import { Outlet, useChildMatches } from "@tanstack/react-router";
import { IntegrationsPage } from "./integrations-page";

export function IntegrationsRoute() {
  // Defer to the child route when one is matched (e.g. /integrations/$provider).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <IntegrationsPage />;
}
