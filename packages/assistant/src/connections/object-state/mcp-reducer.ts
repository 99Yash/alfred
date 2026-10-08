import {
  mcpHealthObjectTitleSchema,
  mcpHealthObjectUrlSchema,
  OBJECT_STATE_CATEGORIES,
} from "@alfred/contracts";
import { z } from "zod";
import type { ObjectStateDelta } from "./store";

/** The only synthetic event an owner-reviewed MCP health pull may fold. */
export const MCP_APPROVED_HEALTH_EVENT_TYPE = "mcp.approved_health";

/** One object kind for every approved MCP connection. */
export const MCP_APPROVED_HEALTH_KIND = "connection_health";

/** Exact keys only. */
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
 * Namespace a loop key by its connection, so two services that both return `ENG-123` stay separate.
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
 * Reducer for owner-reviewed MCP health reads. The caller already mapped the remote token to a
 * canonical state; this validates the synthetic payload, and the store decides the rest.
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
