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

/** A deterministic client/broker rejection, safe for callers to branch on. */
export class McpClientError extends Error {
  readonly code: McpClientErrorCode;

  constructor(code: McpClientErrorCode, message: string) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
  }
}
