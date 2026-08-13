import {
  redactSecrets,
  type PassthroughResult,
  type ReadGateResult,
  type TransportErrorKind,
} from "@alfred/contracts";
import { boundPassthroughBody } from "./bounds";

/**
 * The result shaper — the pure boundary that turns a provider outcome into the
 * honest {@link PassthroughResult} envelope (ADR-0071 #6). It never touches the
 * network: the transport adapter reads the `Response` / catches the transport
 * error and hands the *already-parsed* pieces here, so the shaper stays pure and
 * exhaustively unit-testable. The envelope is explicit about non-completion so
 * the boss never mistakes a wrong-path error for "nothing exists".
 */

/** Build the visible rejection envelope from a read-gate denial. */
export function passthroughRejection(
  gate: Extract<ReadGateResult, { ok: false }>,
): PassthroughResult {
  return { outcome: "rejected", reason: gate.reason, message: gate.detail };
}

export interface HttpResultArgs {
  /** Real HTTP status — for GraphQL this is usually 200 even with errors. */
  status: number;
  /** Parsed JSON value, or bounded text string, for the response body. */
  body: unknown;
  /**
   * For GraphQL: whether the response carried a non-empty `errors[]`. A partial
   * response (`data` *and* `errors[]`) sets `succeeded: false` but keeps the
   * partial `data` in `body` — read both, trust neither as complete.
   */
  graphqlHasErrors?: boolean;
}

/**
 * Shape a completed HTTP exchange (including 4xx/5xx and GraphQL partials). The
 * body is sanitized + bounded here; a clip attaches the truncation thermometer.
 */
export function passthroughHttpResult(args: HttpResultArgs): PassthroughResult {
  const succeeded = args.status >= 200 && args.status < 300 && args.graphqlHasErrors !== true;
  const bounded = boundPassthroughBody(args.body);
  return {
    outcome: "http",
    status: args.status,
    succeeded,
    body: bounded.value,
    ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
  };
}

/**
 * Shape a binary/non-text response. Bytes never enter the transcript: represent
 * it by content type + declared/observed byte count and set `succeeded: false`
 * (actual download/export stays in the curated tier).
 */
export function passthroughBinaryResult(args: {
  status: number;
  contentType: string;
  byteCount: number;
}): PassthroughResult {
  return {
    outcome: "http",
    status: args.status,
    succeeded: false,
    body: {
      binary: true,
      contentType: args.contentType,
      byteCount: args.byteCount,
      note: "Binary response omitted from the transcript. Use a curated download/export tool for the bytes.",
    },
  };
}

/** timeout/connection-reset are transient; dns/tls won't fix on an in-turn retry. */
const RETRYABLE_TRANSPORT: Record<TransportErrorKind, boolean> = {
  timeout: true,
  connection_reset: true,
  dns: false,
  tls: false,
};

/** Shape a transport failure (request left Alfred, no HTTP response arrived). */
export function passthroughTransportError(
  kind: TransportErrorKind,
  message: string,
): PassthroughResult {
  return {
    outcome: "transport",
    kind,
    retryable: RETRYABLE_TRANSPORT[kind],
    message: redactSecrets(message),
  };
}
