import { Outlet, useChildMatches } from "@tanstack/react-router";
import { IntegrationsPage } from "./integrations-page";
import { useAuthorizationRefresh } from "./use-authorization-refresh";

export function IntegrationsRoute() {
  // OAuth finishes in another tab; refresh on return even inside staleTime.
  useAuthorizationRefresh();

  // Flat routes would render the list on the detail URL too, so defer to a matched child.
  const hasChild = useChildMatches().length > 0;

  return hasChild ? <Outlet /> : <IntegrationsPage />;
}
