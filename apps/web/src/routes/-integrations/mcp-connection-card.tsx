import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toMessage } from "@alfred/contracts";
import { Plug } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client, type EdenData } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY } from "./helpers";
import { McpTile } from "./mcp-tile";
import { mcpConnectionSubtitle } from "./mcp-server-status";

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;

export type McpConnection = McpConnectionsResponse["connections"][number];

/**
 * One user-added MCP server: health, tool count, and the two lifecycle actions.
 *
 * The card owns its OWN mutations, one instance per rendered connection. A
 * single mutation object shared by the whole list cannot serve it: `variables`
 * holds the last id mutated, so a second click moves the spinner off the first
 * card while its request — which can run for tens of seconds — is still in
 * flight, and a failure reports against the wrong row.
 *
 * Both actions change the stored row, so both invalidate the connection list
 * here. The card refreshes the list it belongs to; the list does not pass a
 * refresh callback in.
 */
export function McpConnectionCard({ connection }: { connection: McpConnection }) {
  const queryClient = useQueryClient();

  const reconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await client.api.integrations.mcp
        .connections({ id: connection.id })
        .reconnect.post();

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Reconnect MCP server"),
        );
      }

      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await client.api.integrations.mcp
        .connections({ id: connection.id })
        .disconnect.post();

      if (response.error) {
        throw new Error(
          responseErrorMessage(
            response.error.value,
            response.error.status,
            "Disconnect MCP server",
          ),
        );
      }

      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    },
  });

  // The route answers 400 on a refusal. Without this line the spinner stops,
  // the card does not change, and the click reads as a no-op.
  const actionError = reconnectMutation.error ?? disconnectMutation.error;

  return (
    <McpTile
      icon={{ glyph: <Plug size={18} /> }}
      label={connection.label}
      subtitle={
        actionError ? (
          <span role="alert" className="text-app-red-4">
            {toMessage(actionError)}
          </span>
        ) : (
          mcpConnectionSubtitle(connection)
        )
      }
    >
      <div className="flex shrink-0 items-center gap-1">
        <AppButton
          size="sm"
          variant="ghost"
          loading={reconnectMutation.isPending}
          disabled={disconnectMutation.isPending}
          onClick={() => reconnectMutation.mutate()}
        >
          {connection.status === "disconnected" ? "Connect" : "Reconnect"}
        </AppButton>
        {connection.status !== "disconnected" ? (
          <AppButton
            size="sm"
            variant="ghost"
            loading={disconnectMutation.isPending}
            disabled={reconnectMutation.isPending}
            onClick={() => disconnectMutation.mutate()}
          >
            Disconnect
          </AppButton>
        ) : null}
      </div>
    </McpTile>
  );
}
