import { isApiErrorResponse, toMessage } from "@alfred/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY, type McpConnection } from "./helpers";

/** The action in flight; its spinner disables the others. */
export type McpConnectionPendingAction = "reconnect" | "disconnect" | "rename" | "remove";

/**
 * Outcome of the last action. `blocked_remove` is the unresolved-invocation
 * refusal, shown with the recovery anchor. One value, so a refusal and a later
 * failure cannot both render.
 */
export type McpConnectionActionError =
  | { readonly kind: "blocked_remove"; readonly action: "remove"; readonly message: string }
  | {
      readonly kind: "action_failed";
      readonly action: McpConnectionPendingAction;
      readonly message: string;
    };

/** The four lifecycle actions for the card, with one invalidation and one error mapping. */
export interface McpConnectionActions {
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
  readonly onRename: (label: string) => void;
  readonly onRemove: () => void;
  readonly pending: McpConnectionPendingAction | null;
  readonly error: McpConnectionActionError | null;
}

/**
 * Read the wire code, not `response.error.status`: Elysia types the status
 * from the validation shape, so it can say 422 for a thrown conflict.
 */
function isRemovalBlocked(value: unknown): boolean {
  return isApiErrorResponse(value) && value.code === "CONFLICT";
}

/** Tags the refusal while the response is in hand; `onError` only gets the thrown value. */
class McpRemovalRefusedError extends Error {
  constructor(
    readonly kind: "blocked_remove" | "action_failed",
    message: string,
  ) {
    super(message);
    this.name = "McpRemovalRefusedError";
  }
}

export function useMcpConnectionActions(connection: McpConnection): McpConnectionActions {
  const queryClient = useQueryClient();
  const [error, setError] = useState<McpConnectionActionError | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });

  const route = () => client.api.integrations.mcp.connections({ id: connection.id });

  // Each action clears the last outcome first, so the error is always from the latest action.
  const clearError = () => setError(null);

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
    onMutate: clearError,
    onSuccess: invalidate,
    onError: (cause) =>
      setError({ kind: "action_failed", action: "reconnect", message: toMessage(cause) }),
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
    onMutate: clearError,
    onSuccess: invalidate,
    onError: (cause) =>
      setError({ kind: "action_failed", action: "disconnect", message: toMessage(cause) }),
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
    onMutate: clearError,
    onSuccess: invalidate,
    onError: (cause) =>
      setError({ kind: "action_failed", action: "rename", message: toMessage(cause) }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const response = await route().delete();

      if (response.error) {
        // 409 is the unresolved-invocation barrier, not a transport failure.
        throw new McpRemovalRefusedError(
          isRemovalBlocked(response.error.value) ? "blocked_remove" : "action_failed",
          responseErrorMessage(response.error.value, response.error.status, "Remove MCP server"),
        );
      }

      return response.data;
    },
    onMutate: clearError,
    onSuccess: invalidate,
    onError: (cause) =>
      setError({
        kind: cause instanceof McpRemovalRefusedError ? cause.kind : "action_failed",
        action: "remove",
        message: toMessage(cause),
      }),
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

  return {
    onReconnect: () => reconnect.mutate(),
    onDisconnect: () => disconnect.mutate(),
    onRename: (label) => rename.mutate(label),
    onRemove: () => remove.mutate(),
    pending,
    error,
  };
}
