import {
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from "ai";
import { classifyEmail, type ClassifyEmailArgs } from "@alfred/assistant/triage/classify";

/**
 * The provider-weather guards of the triage deck. The deck never throws on these:
 * it records a skip, because a throw aborts the file and hangs the evalite reporter.
 */

/**
 * Why a classify call gave no label. Only `capacity` and `no_output` are provider weather. A
 * `schema_rejection` is an answer that the model gave and the schema refused: a fault of the
 * prompt, the schema, or the model, never weather. `error` is any other throw.
 */
export type ClassifyFailureKind = "capacity" | "no_output" | "schema_rejection" | "error";

export interface ClassifyFailure {
  kind: ClassifyFailureKind;
  /** The error, and for a schema rejection the finish reason, the cause, and the raw answer. */
  detail: string;
}

/** The longest raw answer that a failure detail keeps. */
const RAW_ANSWER_MAX_CHARS = 1200;

/**
 * Reads the AI SDK error contract: `NoObjectGeneratedError` carries the raw `text`, the
 * `finishReason`, and a `cause` (`TypeValidationError` when the answer parsed but did not match
 * the schema, `JSONParseError` when it did not parse). With no text, nothing came back.
 */
export function classifyFailureOf(err: unknown): ClassifyFailure {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  if (NoObjectGeneratedError.isInstance(err)) {
    const cause = err.cause;

    const causeKind = TypeValidationError.isInstance(cause)
      ? "type validation"
      : JSONParseError.isInstance(cause)
        ? "JSON parse"
        : "unknown cause";

    const causeMessage = cause instanceof Error ? cause.message : String(cause);

    if (err.text === undefined || err.text.trim() === "") {
      return { kind: "no_output", detail: `${message} (finish ${err.finishReason ?? "?"})` };
    }

    return {
      kind: "schema_rejection",
      detail: [
        message,
        `finish: ${err.finishReason ?? "?"}`,
        `cause (${causeKind}): ${causeMessage.slice(0, 600)}`,
        `raw answer: ${err.text.slice(0, RAW_ANSWER_MAX_CHARS)}`,
      ].join("\n"),
    };
  }

  if (NoOutputGeneratedError.isInstance(err)) return { kind: "no_output", detail: message };

  if (isTransientOverload(err)) return { kind: "capacity", detail: message };

  return { kind: "error", detail: message };
}

/** A provider capacity error (overloaded, 429, 503). Retrying would only blow the CI time budget. */
function isTransientOverload(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  return /high demand|overloaded|rate.?limit|too many requests|\b429\b|\b503\b|temporarily unavailable|AI_RetryError/i.test(
    msg,
  );
}

/**
 * A 200 with no parseable object. The SDK throws above the layer `withFallback` wraps,
 * so the fallback never engages. A fresh attempt almost always parses.
 */
function isEmptyOutput(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  return /AI_NoOutputGeneratedError|AI_NoObjectGeneratedError|No output generated|No object generated/i.test(
    msg,
  );
}

/** Retries empty output. If every attempt is empty, it rethrows, so a real outage still shows as skips. */
const EMPTY_OUTPUT_ATTEMPTS = 3;

export async function classifyWithRetry(
  args: ClassifyEmailArgs,
): Promise<Awaited<ReturnType<typeof classifyEmail>>> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= EMPTY_OUTPUT_ATTEMPTS; attempt++) {
    try {
      return await classifyEmail(args);
    } catch (err) {
      lastErr = err;

      if (!isEmptyOutput(err) || attempt === EMPTY_OUTPUT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  throw lastErr;
}
