import type { ObjectStateEvent } from "./events";
import type { ObjectStateDelta } from "./store";

/** One object kind for every approved MCP connection. */
export const MCP_APPROVED_HEALTH_KIND = "connection_health";

/** Exact keys only. */
export const MCP_APPROVED_HEALTH_KEY_KIND = "approved_loop_key";

/**
 * Reducer for owner-reviewed MCP health reads. The caller already mapped the remote token to a
 * canonical state and parsed the title and the URL. The branded id proves the identity check ran.
 */
export function reduceMcpEvent({
  payload,
}: Extract<ObjectStateEvent, { provider: "mcp" }>): ObjectStateDelta[] {
  return [
    {
      kind: MCP_APPROVED_HEALTH_KIND,
      externalId: payload.externalId,
      nativeState: payload.state,
      closureSource: "verified_pull",
      title: payload.title ?? undefined,
      url: payload.url ?? undefined,
      keys: [{ keyKind: MCP_APPROVED_HEALTH_KEY_KIND, keyValue: payload.externalId }],
    },
  ];
}
