import { isIndexable, type TransportErrorKind } from "@alfred/contracts";

/**
 * Classify a thrown fetch error. undici puts the code on `err.cause.code`;
 * `AbortSignal.timeout` throws by name. Anything unknown is a retryable connection reset.
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
 * Uses {@link isIndexable}, not `isRecord`: `isRecord` rejects Error instances,
 * which would turn every failure into `connection_reset`.
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

function readStringField(value: unknown, field: string): string | null {
  if (!isIndexable(value)) return null;
  const read = Reflect.get(value, field);

  return typeof read === "string" ? read : null;
}
