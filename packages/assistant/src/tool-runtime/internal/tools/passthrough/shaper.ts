import {
  redactSecrets,
  type PassthroughResult,
  type ReadGateResult,
  type TransportErrorKind,
} from "@alfred/contracts";
import { boundPassthroughBody } from "./bounds";

/**
 * Turn a parsed provider outcome into a {@link PassthroughResult} (ADR-0071 #6).
 * The envelope marks non-completion, so a wrong-path error never reads as "nothing exists".
 */

export function passthroughRejection(
  gate: Extract<ReadGateResult, { ok: false }>,
): PassthroughResult {
  return { outcome: "rejected", reason: gate.reason, message: gate.detail };
}

export interface HttpResultArgs {
  /** GraphQL usually answers 200 even with errors. */
  status: number;
  body: unknown;
  /** A partial GraphQL response keeps its `data` but sets `succeeded: false`. */
  graphqlHasErrors?: boolean;
}

/** Any HTTP response, 4xx/5xx included. A clipped body carries `truncation`. */
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

/** Bytes never enter the transcript. Downloads stay in the curated tools. */
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

/** A DNS or TLS failure will not fix itself on an in-turn retry. */
const RETRYABLE_TRANSPORT = {
  timeout: true,
  connection_reset: true,
  dns: false,
  tls: false,
} satisfies Record<TransportErrorKind, boolean>;

/** The request left Alfred but no HTTP response arrived. */
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
