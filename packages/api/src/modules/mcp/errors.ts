export const MCP_CLIENT_ERROR_CODES = [
  "not_connected",
  "session_expired",
  "unsupported_protocol_version",
  "missing_tools_capability",
  "catalog_required",
  "catalog_stale",
  "catalog_limit",
  "duplicate_tool",
  "invalid_schema",
  "unknown_tool",
  "invalid_arguments",
  "invalid_output",
  "unsupported_task_tool",
] as const;

export type McpClientErrorCode = (typeof MCP_CLIENT_ERROR_CODES)[number];

/**
 * Codes thrown DETERMINISTICALLY before `client.callTool` awaits
 * `protocol.callTool(...)` — the delivery boundary in `client.ts`. A failure
 * carrying one of these provably never reached the remote application, so it is
 * safe to treat as *not delivered* (retry-safe). Everything else
 * (`session_expired`, `invalid_output`, a transport/abort throw) happens at or
 * after that await and must be treated as possibly-delivered by the broker's
 * ambiguity ledger.
 *
 * Kept BESIDE the code union on purpose: a new code must be classified here, in
 * the same file it is declared, rather than in a denylist shadowing the boundary
 * from another module. The unsafe direction (omission → possibly-delivered) is
 * the safe default, so a forgotten entry over-blocks rather than mis-retries.
 */
const MCP_PRE_DELIVERY_ERROR_CODES: ReadonlySet<McpClientErrorCode> = new Set([
  "not_connected",
  "catalog_required",
  "catalog_stale",
  "unknown_tool",
  "invalid_arguments",
  "unsupported_task_tool",
]);

/** True for a deterministic pre-delivery code (provably not delivered). */
export function isPreDeliveryErrorCode(code: McpClientErrorCode): boolean {
  return MCP_PRE_DELIVERY_ERROR_CODES.has(code);
}

/** A deterministic client/broker rejection, safe for callers to branch on. */
export class McpClientError extends Error {
  readonly code: McpClientErrorCode;

  constructor(code: McpClientErrorCode, message: string) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
  }
}
