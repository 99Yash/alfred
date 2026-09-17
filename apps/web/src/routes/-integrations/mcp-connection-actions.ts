import { isApiErrorResponse, toMessage } from "@alfred/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY, type McpConnection } from "./helpers";

/** Which lifecycle action is in flight, so one spinner at a time disables its siblings. */
export type McpConnectionPendingAction = "reconnect" | "disconnect" | "rename" | "remove";

/**
 * One connection's four lifecycle actions, flattened for the card.
 *
 * The card renders this object; it never touches a mutation. That keeps the
 * single `MCP_CONNECTIONS_QUERY_KEY` invalidation and the error-to-message
 * mapping in one place — four inline mutation blocks per card previously each
 * carried their own invalidation and their own `responseErrorMessage` call.
 *
 * `removeBlocked` is the one bit the card branches on: the DELETE answers 409
 * while an unresolved invocation exists, and that refusal must point the owner
 * at the recovery list rather than read as a generic failure.
 */
export interface McpConnectionActions {
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
  readonly onRename: (label: string) => void;
  readonly onRemove: () => void;
  readonly pending: McpConnectionPendingAction | null;
  readonly error: string | null;
  readonly removeBlocked: boolean;
}

/**
 * A removal refused by the unresolved-invocation barrier. The status is read
 * from the wire CODE, not `response.error.status`: Elysia types a route's error
 * status from its own validation shape, so the numeric status here can be the
 * 422 default even when the handler threw a conflict.
 */
function isRemovalBlocked(value: unknown): boolean {
  return isApiErrorResponse(value) && value.code === "CONFLICT";
}

export function useMcpConnectionActions(connection: McpConnection): McpConnectionActions {
  const queryClient = useQueryClient();
  const [removeBlocked, setRemoveBlocked] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });

  const route = () => client.api.integrations.mcp.connections({ id: connection.id });

  const reconnect = useMutation({
    mutationFn: async () => {
      const response = await route().reconnect.post();

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Reconnect MCP server"),
        );
      }

      return response.data;
    },
    onSuccess: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const response = await route().disconnect.post();

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
    onSuccess: invalidate,
  });

  const rename = useMutation({
    mutationFn: async (label: string) => {
      const response = await route().patch({ label });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Rename MCP server"),
        );
      }

      return response.data;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async () => {
      setRemoveBlocked(false);
      const response = await route().delete();

      if (response.error) {
        // A 409 is the unresolved-invocation barrier, not a transport failure;
        // the card renders it with the recovery anchor.
        setRemoveBlocked(isRemovalBlocked(response.error.value));

        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Remove MCP server"),
        );
      }

      return response.data;
    },
    onSuccess: invalidate,
  });

  const pending: McpConnectionPendingAction | null = reconnect.isPending
    ? "reconnect"
    : disconnect.isPending
      ? "disconnect"
      : rename.isPending
        ? "rename"
        : remove.isPending
          ? "remove"
          : null;

  const actionError = reconnect.error ?? disconnect.error ?? rename.error ?? remove.error;

  return {
    onReconnect: () => reconnect.mutate(),
    onDisconnect: () => disconnect.mutate(),
    onRename: (label) => rename.mutate(label),
    onRemove: () => remove.mutate(),
    pending,
    error: actionError ? toMessage(actionError) : null,
    removeBlocked: removeBlocked && remove.error !== null,
  };
}
