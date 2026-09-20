import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { INTEGRATION_STATUS_QUERY_KEY } from "~/lib/integrations/use-integration-status";
import { MCP_CONNECTIONS_QUERY_KEY } from "./helpers";

/**
 * Refresh integration reads when the tab regains focus after an OAuth round
 * trip in another tab. React Query's `refetchOnWindowFocus` only refetches
 * stale queries, so without this a return within `staleTime` leaves the
 * original card showing the pre-authorization state. Mounted by
 * `IntegrationsRoute`, which owns both query keys below.
 */
export function useAuthorizationRefresh(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    };

    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  }, [queryClient]);
}
