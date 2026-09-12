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
 * The text of an error AND its cause chain. Node's `fetch` reports every
 * socket-level failure as a bare `TypeError: fetch failed` and hides the reason
 * (`ECONNREFUSED`, `ENOTFOUND`, this module's own `EBLOCKEDHOST`) on `cause`;
 * `toMessage` alone would persist "fetch failed" for a DNS-rebinding refusal,
 * which is the one case an operator most needs to see. A hosted-endpoint
 * refusal wins outright so both of its encodings land as the same sentence.
 *
 * {@link causeChain} reads the SDK's `data.cause` as well as `Error.cause`. That
 * second shape is the whole chain when the SDK's version-negotiation probe is
 * what failed, so without it a blocked host, a timeout and a refused connection
 * all persist the same four words.
 */
function causeChainText(err: unknown): string {
  const hosted = hostedEndpointErrorFrom(err);

  if (hosted) return hosted.message;

  return causeChain(err).map(toMessage).join(": ");
}

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
  return summarizeBody(sanitizeErrorMessage(causeChainText(err)), MAX_MCP_ERROR_CHARS);
}

/**
 * True when a connect attempt failed because the server demands sign-in.
 *
 * Kept BESIDE the other MCP error classifiers, for the reason stated above the
 * pre-delivery set: a denylist that shadows this boundary from another module
 * drifts from the SDK's shapes without any reader noticing. The transport
 * throws `UnauthorizedError` on a 401 when no `authProvider` can retry, and the
 * version-negotiation probe reports the same fact as an `SdkHttpError` with
 * status 401, so both are one question with one answer.
 */
export function isMcpAuthorizationChallenge(err: unknown): boolean {
  return causeChain(err).some(
    (link) =>
      UnauthorizedError.isInstance(link) || (link instanceof SdkHttpError && link.status === 401),
  );
}

/**
 * True when a failure is the ENDPOINT's answer, and false when it is Alfred's
 * own fault.
 *
 * A route that maps every throw to one status tells the owner to fix a URL that
 * is fine, or hides a failed insert behind a sentence about the network. The
 * four shapes below are the only ones that reach a caller from an MCP
 * conversation: a `HostedEndpointError` (URL shape or blocked address), this
 * module's own deterministic rejection, any SDK transport or protocol error,
 * and Node's bare `TypeError: fetch failed`.
 *
 * Here, with the code union and the pre-delivery set, for the reason stated
 * above them: a shape list that shadows this boundary from another module drifts
 * from the SDK without a reader noticing. The `cause` test is what separates
 * `fetch failed` from an ordinary programming `TypeError`, which carries none.
 */
export function isMcpEndpointRefusal(err: unknown): boolean {
  return (
    hostedEndpointErrorFrom(err) !== null ||
    err instanceof McpClientError ||
    SdkError.isInstance(err) ||
    (err instanceof TypeError && err.cause !== undefined)
  );
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
