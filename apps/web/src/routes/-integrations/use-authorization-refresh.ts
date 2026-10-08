import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { INTEGRATION_STATUS_QUERY_KEY } from "~/lib/integrations/use-integration-status";
import { MCP_CONNECTIONS_QUERY_KEY } from "./helpers";

/**
 * Refetch integration reads on focus after OAuth in another tab.
 * `refetchOnWindowFocus` skips fresh queries, so the card would stay stale.
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
