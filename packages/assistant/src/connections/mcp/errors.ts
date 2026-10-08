import { SdkError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import {
  causeChain,
  sanitizeErrorMessage,
  summarizeBody,
  toMessage,
  type McpResultProvenance,
} from "@alfred/contracts";
import { hostedEndpointErrorFrom } from "../hosted-endpoint";

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
  "write_tool",
  "unknown_tool",
  "invalid_arguments",
  "invalid_output",
  "insufficient_scope",
  "admission_full",
] as const;

export type McpClientErrorCode = (typeof MCP_CLIENT_ERROR_CODES)[number];

/**
 * Codes that prove the call never reached the remote tool, so a retry is safe.
 * `insufficient_scope` is a 403 before the tool ran. A code missing here counts
 * as possibly delivered, which over-blocks instead of re-sending.
 */
const MCP_PRE_DELIVERY_ERROR_CODES: ReadonlySet<McpClientErrorCode> = new Set([
  "not_connected",
  "catalog_required",
  "catalog_stale",
  "unknown_tool",
  "write_tool",
  "invalid_arguments",
  "insufficient_scope",
  "admission_full",
]);

/** True for a code that proves the call was not delivered. */
export function isPreDeliveryErrorCode(code: McpClientErrorCode): boolean {
  return MCP_PRE_DELIVERY_ERROR_CODES.has(code);
}

/** Cap on error text persisted to an MCP row (connection `lastError`, ledger row). */
const MAX_MCP_ERROR_CHARS = 500;

/**
 * Error text with its cause chain. Node's `fetch` hides the real reason
 * (`ECONNREFUSED`, `EBLOCKEDHOST`) on `cause` behind "fetch failed".
 */
function causeChainText(err: unknown): string {
  const hosted = hostedEndpointErrorFrom(err);

  if (hosted) return hosted.message;

  return causeChain(err).map(toMessage).join(": ");
}

/**
 * Sanitize (ADR-0070), redact, and truncate MCP error text before storing it.
 * The SDK puts the whole remote response body in its error message.
 */
export function boundedMcpErrorText(err: unknown): string {
  return summarizeBody(sanitizeErrorMessage(causeChainText(err)), MAX_MCP_ERROR_CHARS);
}

/** The server demands sign-in: `UnauthorizedError`, or an `SdkHttpError` 401 from the version probe. */
export function isMcpAuthorizationChallenge(err: unknown): boolean {
  return causeChain(err).some(
    (link) =>
      UnauthorizedError.isInstance(link) || (link instanceof SdkHttpError && link.status === 401),
  );
}

/** Retry only socket and fetch failures, never a remote authorization or protocol answer. */
export function isMcpTransportFailure(err: unknown): boolean {
  if (isMcpAuthorizationChallenge(err) || hostedEndpointErrorFrom(err)) return false;

  return causeChain(err).some((link) => {
    if (link instanceof TypeError && link.message === "fetch failed") return true;

    if (!(link instanceof Error) || !("code" in link)) return false;

    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(String(link.code));
  });
}

/**
 * True when the endpoint caused the failure, false when Alfred did.
 * The `cause` test separates `fetch failed` from a plain `TypeError` bug.
 */
export function isMcpEndpointRefusal(err: unknown): boolean {
  return (
    hostedEndpointErrorFrom(err) !== null ||
    err instanceof McpClientError ||
    err instanceof McpApiKeyRejectedError ||
    SdkError.isInstance(err) ||
    (err instanceof TypeError && err.cause !== undefined)
  );
}

/** The endpoint refused the owner's API key. No consent screen can fix this, so the add fails. */
export class McpApiKeyRejectedError extends Error {
  constructor() {
    super("The MCP server rejected the supplied API key.");
    this.name = "McpApiKeyRejectedError";
  }
}

/** A deterministic client/broker rejection, safe for callers to branch on. */
export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  /** Set only when a response arrived (`invalid_output`), so the broker can store provenance. */
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
