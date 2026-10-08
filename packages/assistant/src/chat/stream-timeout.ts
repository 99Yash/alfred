/**
 * True when the stream timeout aborted the turn: a `DOMException` named `"TimeoutError"`.
 * A user stop is an unnamed `AbortError`. `DOMException` is not an `Error` in Node,
 * so match on `name`, not `instanceof`.
 */

import { isIndexable } from "@alfred/contracts";

export function isStreamTimeoutAbort(err: unknown): boolean {
  return isIndexable(err) && Reflect.get(err, "name") === "TimeoutError";
}
