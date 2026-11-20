import { boundForModel, MODEL_RESULT_MAX_BYTES, type ResultTruncation } from "./bound";
import { toJsonValue } from "./json";
import { sanitizeToolResult } from "./sanitize";
import type { JsonValue } from "./user-model";

/**
 * Bound an untrusted provider body before the model sees it (ADR-0074). Steps: strip NUL and lone
 * surrogates, then apply the one size rule (ADR-0130 decision 5, `boundForModel`).
 */

/**
 * An untouched body keeps its type. A body that the bound changed is a `JsonValue` and carries
 * `truncation`, so a typed read must check `truncation` first.
 */
export type BoundedPassthroughBody<T = unknown> =
  | { value: T; truncation?: undefined }
  | { value: JsonValue; truncation: ResultTruncation };

/**
 * Safe to run with the dispatch-boundary sanitize pass too. `limitBytes` defaults to the model's
 * limit. A tool that saves its result for a later read passes the stored cap instead, and the chat
 * boundary bounds the model's copy.
 */
export function boundPassthroughBody<T>(
  input: T,
  limitBytes: number = MODEL_RESULT_MAX_BYTES,
): BoundedPassthroughBody<T> {
  const sanitized = sanitizeToolResult(input).value;
  const bounded = boundForModel(toJsonValue(sanitized), limitBytes);

  return bounded.truncation
    ? { value: bounded.value, truncation: bounded.truncation }
    : { value: sanitized };
}
