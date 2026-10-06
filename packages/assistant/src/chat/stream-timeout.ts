/**
 * True when a thrown error is the streaming circuit-breaker aborting the turn:
 * the stream ran past its total (default 180s) or chunk-gap (30s) ceiling and
 * the AI SDK aborted the provider call. The SDK signals this with a
 * `DOMException` whose `name` is `"TimeoutError"` — `AbortSignal.timeout` for
 * the total ceiling, an explicit `DOMException(..., "TimeoutError")` for the
 * chunk/step ceilings — which then rejects `stream.finalStep`.
 *
 * This is structurally distinct from the two aborts we already handle: a user
 * stop is an unnamed `AbortError` (and gated on `stopRequested`), and a
 * provider fault is an `HttpError`/APICallError. A timeout means the model ran
 * long, not that anything is broken — so it's recoverable by re-issuing the
 * turn from the unchanged pre-turn transcript. `DOMException` is not an
 * `Error` subclass in Node, so match structurally on `name` rather than
 * `instanceof` — `isIndexable` + `Reflect.get`, not a cast.
 *
 * Its own module because both halves of the turn read it: the chat turn's
 * retry branch (recover from it) and `classifyChatFailure` (tag it `timeout`
 * rather than letting the transient-fault net call it `overloaded`).
 */

import { isIndexable } from "@alfred/contracts";

export function isStreamTimeoutAbort(err: unknown): boolean {
  return isIndexable(err) && Reflect.get(err, "name") === "TimeoutError";
}
