import { isIndexable, type TransportErrorKind } from "@alfred/contracts";

/**
 * Classify a thrown fetch error into a {@link TransportErrorKind} for the honest
 * passthrough envelope. A transport failure means the request left Alfred but no
 * HTTP response arrived — distinct from a 4xx/5xx (which IS a response and rides
 * the `http` outcome). Kept pure and dependency-free so every provider adapter
 * classifies identically.
 *
 * `fetch` (undici) surfaces the cause as `err.cause.code`; `AbortSignal.timeout`
 * throws a `TimeoutError`/`AbortError` by name. Anything unrecognized is treated
 * as a connection reset (retryable-once), which is the safe default for a
 * transient network blip.
 */
export function classifyTransportError(err: unknown): TransportErrorKind {
  const name = errorName(err);
  if (name === "TimeoutError" || name === "AbortError") return "timeout";

  const code = transportCode(err);
  if (code) {
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
    if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SSL")) {
      return "tls";
    }
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ECONNABORTED" ||
      code === "EPIPE" ||
      code === "UND_ERR_SOCKET"
    ) {
      return "connection_reset";
    }
  }
  return "connection_reset";
}

function errorName(err: unknown): string | null {
  if (err instanceof Error) return err.name;
  const name = readStringField(err, "name");
  return name;
}

/**
 * Reach the undici cause code (`err.cause.code`), or a top-level `code`. A real
 * `fetch` failure is a `TypeError` instance whose `.cause` is a system `Error`,
 * so this MUST use {@link isIndexable}, not `isRecord` — `isRecord` rejects class
 * instances (and any `.cause` that is an Error), which would collapse every DNS /
 * TLS / reset failure into the `connection_reset` default and defeat the whole
 * classifier.
 */
function transportCode(err: unknown): string | null {
  const top = readStringField(err, "code");
  if (top) return top;
  if (isIndexable(err)) {
    const cause = Reflect.get(err, "cause");
    return readStringField(cause, "code");
  }
  return null;
}

/** Read a string-valued field off any runtime object (a caught error), or null. */
function readStringField(value: unknown, field: string): string | null {
  if (!isIndexable(value)) return null;
  const read = Reflect.get(value, field);
  return typeof read === "string" ? read : null;
}
