import { isApiErrorResponse, toMessage } from "@alfred/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY, type McpConnection } from "./helpers";

/** Which lifecycle action is in flight, so one spinner at a time disables its siblings. */
export type McpConnectionPendingAction = "reconnect" | "disconnect" | "rename" | "remove";

/**
 * The outcome of the last lifecycle action on this row, as one value.
 *
 * `blocked_remove` is the DELETE's unresolved-invocation refusal, which the card
 * renders with the recovery anchor; `action_failed` is every other failure and
 * carries no anchor.
 *
 * This is one discriminated value, not an error message beside a separate
 * `removeBlocked` boolean projected from the same four mutations. Two
 * projections can disagree: a resolved refusal keeps rendering as refused, and
 * a later failed reconnect renders its own message under the removal anchor.
 * Neither sequence is representable here.
 */
export type McpConnectionActionError =
  | { readonly kind: "blocked_remove"; readonly action: "remove"; readonly message: string }
  | {
      readonly kind: "action_failed";
      readonly action: McpConnectionPendingAction;
      readonly message: string;
    };

/**
 * One connection's four lifecycle actions, flattened for the card.
 *
 * The card renders this object; it never touches a mutation. That keeps the
 * single `MCP_CONNECTIONS_QUERY_KEY` invalidation and the error-to-message
 * mapping in one place — four inline mutation blocks per card previously each
 * carried their own invalidation and their own `responseErrorMessage` call.
 */
export interface McpConnectionActions {
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
  readonly onRename: (label: string) => void;
  readonly onRemove: () => void;
  readonly pending: McpConnectionPendingAction | null;
  readonly error: McpConnectionActionError | null;
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

/**
 * A removal's refusal, tagged where the wire response is still in hand.
 *
 * `onError` receives only the thrown value, so the one branch the card needs —
 * barrier or ordinary failure — travels on the error rather than being guessed
 * from a second piece of state.
 */
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

  // Each action clears the previous outcome as it starts, so the rendered error
  // is always the outcome of the LAST action on this row. A success therefore
  // clears a stale refusal, and a later failure cannot inherit its anchor.
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
        // A 409 is the unresolved-invocation barrier, not a transport failure;
        // the card renders it with the recovery anchor.
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
