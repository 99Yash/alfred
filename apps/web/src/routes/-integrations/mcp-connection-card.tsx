import { useMutation } from "@tanstack/react-query";
import { toMessage } from "@alfred/contracts";
import { Plug } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client, type EdenData } from "~/lib/eden";
import { McpTile } from "./mcp-tile";
import { mcpConnectionStatusText } from "./mcp-server-status";

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;

export type McpConnection = McpConnectionsResponse["connections"][number];

/**
 * Status text plus the published tool count once a revision exists. The count
 * is the one fact a fresh no-auth connection can report without a call, so it
 * is folded into the same line rather than a second field.
 */
function connectionSubtitle(connection: McpConnection): string {
  const status = mcpConnectionStatusText(connection);

  if (connection.status !== "ready" || connection.toolCount === null) return status;

  return `${status} · ${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`;
}

/**
 * One user-added MCP server: health, tool count, and the two lifecycle actions.
 *
 * The card owns its OWN mutations, one instance per rendered connection. A
 * single mutation object shared by the whole list cannot serve it: `variables`
 * holds the last id mutated, so a second click moves the spinner off the first
 * card while its request — which can run for tens of seconds — is still in
 * flight, and a failure reports against the wrong row.
 */
export function McpConnectionCard({
  connection,
  onChanged,
}: {
  connection: McpConnection;
  onChanged: () => void;
}) {
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
    onSuccess: onChanged,
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
    onSuccess: onChanged,
  });

  // The route answers 400 on a refusal. Without this line the spinner stops,
  // the card does not change, and the click reads as a no-op.
  const actionError = reconnectMutation.error ?? disconnectMutation.error;

  return (
    <McpTile
      icon={<Plug size={18} />}
      label={connection.label}
      subtitle={
        actionError ? (
          <span role="alert" className="text-app-red-4">
            {toMessage(actionError)}
          </span>
        ) : (
          connectionSubtitle(connection)
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
