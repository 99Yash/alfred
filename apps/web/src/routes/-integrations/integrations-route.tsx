import { Outlet, useChildMatches } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { INTEGRATION_STATUS_QUERY_KEY } from "~/lib/integrations/use-integration-status";
import { IntegrationsPage } from "./integrations-page";
import { MCP_CONNECTIONS_QUERY_KEY } from "./helpers";

export function IntegrationsRoute() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // OAuth finishes in another tab. Refresh even when the cached result is
    // still inside its staleTime, so the original card changes on return.
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    };

    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  }, [queryClient]);

  // Defer to the child route when one is matched (e.g. /integrations/$slug).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;

  return hasChild ? <Outlet /> : <IntegrationsPage />;
}
