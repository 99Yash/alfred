import {
  sanitizeErrorMessage,
  summarizeBody,
  toMessage,
  type McpResultProvenance,
} from "@alfred/contracts";

export const MCP_CLIENT_ERROR_CODES = [
  "not_connected",
  "session_expired",
  "unsupported_protocol_version",
  "missing_tools_capability",
  "catalog_required",
  "catalog_stale",
  "descriptor_mismatch",
  "catalog_limit",
  "duplicate_tool",
  "invalid_schema",
  "unknown_tool",
  "invalid_arguments",
  "invalid_output",
  "insufficient_scope",
  "admission_full",
] as const;

export type McpClientErrorCode = (typeof MCP_CLIENT_ERROR_CODES)[number];

/**
 * Codes thrown DETERMINISTICALLY before `client.callTool` awaits
 * `protocol.callTool(...)` — the delivery boundary in `client.ts`. A failure
 * carrying one of these provably never reached the remote application, so it is
 * safe to treat as *not delivered* (retry-safe). Everything else
 * (`session_expired`, `invalid_output`, a transport/abort throw) happens at or
 * after that await and must be treated as possibly-delivered by the broker's
 * ambiguity ledger. `insufficient_scope` is the one response-side exception:
 * the resource server's 403 bearer challenge proves authorization rejected the
 * request before the MCP tool ran. `admission_full` is the broker's own refusal:
 * its process-local capacity was exhausted before any provider work started.
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
  "insufficient_scope",
  "admission_full",
]);

/** True for a deterministic pre-delivery code (provably not delivered). */
export function isPreDeliveryErrorCode(code: McpClientErrorCode): boolean {
  return MCP_PRE_DELIVERY_ERROR_CODES.has(code);
}

/** Cap on error text persisted to an MCP row (connection `lastError`, ledger row). */
const MAX_MCP_ERROR_CHARS = 500;

/**
 * The one funnel every MCP failure passes through before it reaches a durable
 * column: strip poison (ADR-0070) → redact secrets → bound with a visible
 * truncation marker.
 *
 * It is not a convenience. An MCP server is the least trusted counterparty
 * Alfred talks to, and the SDK inlines the *entire* upstream response body into
 * the message it throws — `StreamableHTTPError(status, "Error POSTing to
 * endpoint: ${text}")` — so a bare `toMessage(err)` writes an unbounded,
 * unredacted remote body into Postgres. That is the same hazard the provider
 * transports express as `bodyPolicy: "omit"`; MCP cannot reuse that factory
 * (there is no `Response` here, only a thrown SDK error), so the bound lives on
 * this side of the seam instead.
 *
 * Kept beside {@link McpClientError} because both the connection manager and the
 * execution broker record failures, and a second copy in whichever module got
 * there first is exactly how one of them ends up unbounded.
 */
export function boundedMcpErrorText(err: unknown): string {
  return summarizeBody(sanitizeErrorMessage(toMessage(err)), MAX_MCP_ERROR_CHARS);
}

/** A deterministic client/broker rejection, safe for callers to branch on. */
export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  /**
   * The content census computed at the instant a response crossed the wire,
   * attached when the failure happened AFTER delivery (today: `invalid_output`).
   * It lets the broker persist result provenance for an otherwise-ambiguous
   * outcome (#541) instead of losing everything but an error string to prose.
   * Absent for pre-delivery / transport failures, where no response was received.
   */
  readonly provenance?: McpResultProvenance;

  constructor(
    code: McpClientErrorCode,
    message: string,
    options?: { provenance?: McpResultProvenance },
  ) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    if (options?.provenance) this.provenance = options.provenance;
  }
}
