import { boundForModel, type ResultTruncation } from "./bound";
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

/** Safe to run with the dispatch-boundary sanitize pass too. */
export function boundPassthroughBody<T>(input: T): BoundedPassthroughBody<T> {
  const sanitized = sanitizeToolResult(input).value;
  const bounded = boundForModel(toJsonValue(sanitized));

  return bounded.truncation
    ? { value: bounded.value, truncation: bounded.truncation }
    : { value: sanitized };
}
