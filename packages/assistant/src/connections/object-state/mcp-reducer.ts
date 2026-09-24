import {
  mcpHealthObjectTitleSchema,
  mcpHealthObjectUrlSchema,
  OBJECT_STATE_CATEGORIES,
} from "@alfred/contracts";
import { z } from "zod";
import type { ObjectStateDelta } from "./store";

/** The one synthetic event an owner-reviewed MCP health pull may fold. */
export const MCP_APPROVED_HEALTH_EVENT_TYPE = "mcp.approved_health";

/** One fixed object kind serves every owner-approved MCP connection. */
export const MCP_APPROVED_HEALTH_KIND = "connection_health";

/** Exact keys only; a provider identity is never abbreviated by this lane. */
export const MCP_APPROVED_HEALTH_KEY_KIND = "approved_loop_key";

const MAX_CONNECTION_ID_LENGTH = 128;

const MAX_LOOP_KEY_LENGTH = 512;

const mcpApprovedHealthPayloadSchema = z
  .object({
    connectionId: z.string().min(1).max(MAX_CONNECTION_ID_LENGTH),
    loopKey: z.string().min(1).max(MAX_LOOP_KEY_LENGTH),
    state: z.enum(OBJECT_STATE_CATEGORIES),
    title: mcpHealthObjectTitleSchema.nullable(),
    url: mcpHealthObjectUrlSchema.nullable(),
  })
  .strict();

/**
 * Namespace a generic loop key by the approved connection that produced it.
 * Two accounts for the same service therefore cannot collide, and two services
 * that happen to return `ENG-123` remain separate objects.
 */
export function approvedMcpHealthExternalId(input: {
  connectionId: string;
  loopKey: string;
}): string | null {
  if (
    input.connectionId.length === 0 ||
    input.connectionId.length > MAX_CONNECTION_ID_LENGTH ||
    input.loopKey.length === 0 ||
    input.loopKey.length > MAX_LOOP_KEY_LENGTH ||
    input.connectionId.includes("|") ||
    input.loopKey.includes("|")
  ) {
    return null;
  }

  return `${input.connectionId}|${input.loopKey}`;
}

/**
 * Generic reducer for owner-reviewed MCP health reads.
 *
 * The caller has already boundary-validated the remote result against the
 * owner's reviewed mapping and translated an exact provider token into the
 * canonical state vocabulary. This reducer validates the synthetic payload at
 * the store boundary, then emits the ordinary `ObjectStateDelta`; every unknown
 * kind/token, absorption, and recency decision remains inside `objectStateStore`.
 */
export function reduceMcpEvent(
  eventType: string,
  _action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  if (eventType !== MCP_APPROVED_HEALTH_EVENT_TYPE) return [];

  const parsed = mcpApprovedHealthPayloadSchema.safeParse(payload);

  if (!parsed.success) return [];

  const externalId = approvedMcpHealthExternalId(parsed.data);

  if (!externalId) return [];

  return [
    {
      kind: MCP_APPROVED_HEALTH_KIND,
      externalId,
      nativeState: parsed.data.state,
      closureSource: "verified_pull",
      title: parsed.data.title ?? undefined,
      url: parsed.data.url ?? undefined,
      keys: [{ keyKind: MCP_APPROVED_HEALTH_KEY_KIND, keyValue: externalId }],
    },
  ];
}
