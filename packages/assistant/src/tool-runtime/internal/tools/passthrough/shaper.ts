import {
  redactSecrets,
  sanitizeToolResult,
  type PassthroughResult,
  type ResultRecipient,
  type ReadGateResult,
  type TransportErrorKind,
} from "@alfred/contracts";
import { HOST_READ_DELIVERY_MAX_BYTES } from "../../../code-mode/result-budget";
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
  /**
   * A script gets the whole sanitized body. A direct call keeps a copy within the stored cap, and
   * the chat boundary bounds the model's copy (ADR-0130 decision 5).
   */
  recipient?: ResultRecipient;
}

/** The recipient of a tool's result: a read inside a `system.code_run` script, or the model. */
export function resultRecipientOf(runContext: { readPath?: string | undefined }): ResultRecipient {
  return runContext.readPath === "code_run_host" ? "script" : "model";
}

/** Any HTTP response, 4xx/5xx included. A clipped body carries `truncation`. */
export function passthroughHttpResult(args: HttpResultArgs): PassthroughResult {
  const succeeded = args.status >= 200 && args.status < 300 && args.graphqlHasErrors !== true;

  if (args.recipient === "script") {
    return {
      outcome: "http",
      status: args.status,
      succeeded,
      body: sanitizeToolResult(args.body).value,
    };
  }

  // The stored cap, so the staging row and the handle stay bounded. The chat boundary bounds the
  // model's copy (ADR-0130 decision 5).
  const bounded = boundPassthroughBody(args.body, HOST_READ_DELIVERY_MAX_BYTES);

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
