import { Outlet, useChildMatches } from "@tanstack/react-router";
import { IntegrationsPage } from "./integrations-page";
import { useAuthorizationRefresh } from "./use-authorization-refresh";

export function IntegrationsRoute() {
  // OAuth finishes in another tab (see `authorization-tab`). Refresh even
  // when the cached result is still inside its staleTime, so the original
  // card changes on return.
  useAuthorizationRefresh();

  // Defer to the child route when one is matched (e.g. /integrations/$slug).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;

  return hasChild ? <Outlet /> : <IntegrationsPage />;
}
