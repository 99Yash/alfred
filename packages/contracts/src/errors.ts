/**
 * Shared error primitives.
 *
 * Three things kept getting hand-rolled across the codebase, each slightly
 * differently:
 *
 *   1. `err instanceof Error ? err.message : String(err)` — repeated ~95×.
 *   2. Bounding an external error body before logging it — `body.slice(0, 500)`
 *      in the Google integrations, `slice(0, 300)` in GitHub, a `2_000` cap in
 *      Railway, and dropped entirely in Notion. No single source of truth for
 *      "how much of an upstream body is safe to keep."
 *   3. Discriminating an error by sniffing its message string
 *      (`err.message.startsWith("[gmail]")`) because the throw carried no
 *      structured fields — no status, no provider, no retryable flag.
 *
 * This module is the one home for all three. It lives in `@alfred/contracts`
 * (zod-only, client-safe) so integrations, the API, the AI layer, and the web
 * bundle can all import it without crossing a package boundary.
 */

/**
 * Max chars of an external error body we retain. Bounded so a giant HTML error
 * page or stack-trace dump can't bloat a log line, and — unlike the old inline
 * `slice(0, 500)` / `slice(0, 300)` / `2_000` scattering — uniform everywhere.
 */
export const MAX_ERROR_BODY_CHARS = 500;

/**
 * Turn an unknown thrown value into a string message. The canonical form of
 * the `err instanceof Error ? err.message : String(err)` idiom — same
 * semantics, one place to improve.
 */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Strip high-confidence secrets from text before it lands in an error message
 * or log. Targets `Bearer`/`Basic`/`Token` auth values and the common
 * `secret-ish-key: value` shapes (access/refresh tokens, client secrets, API
 * keys, passwords). Not exhaustive by design — a bound plus this pass make a
 * 4xx body safe to log without hand-auditing every provider's error shape.
 * Over-redaction in an error body is an acceptable trade for never leaking a
 * credential into a log.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(
      /\b(access_token|refresh_token|client_secret|api[-_]?key|apikey|authorization|password|secret|token)\b(\s*["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/gi,
      "$1$2[redacted]",
    );
}

/**
 * Render an external body for safe logging: redact secrets, then bound it with
 * a visible truncation marker (so a clipped body reads as clipped, not as the
 * whole thing). The single funnel every `HttpError` body passes through.
 */
export function summarizeBody(text: string, max: number = MAX_ERROR_BODY_CHARS): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…[+${redacted.length - max} chars]`;
}

interface HttpErrorArgs {
  provider: string;
  status: number;
  url: string;
  /** Pre-summarized body (already redacted + bounded). */
  body: string;
  method?: string;
}

/**
 * A failed HTTP response from an upstream provider, carrying structured fields
 * instead of a formatted-string-only throw. Callers branch on `status` /
 * `provider` / {@link HttpError.retryable} rather than regexing the message;
 * the message itself stays human-readable for logs.
 *
 * Discriminate with the literal `_tag` (or {@link isHttpError}) — never by
 * message prefix.
 */
export class HttpError extends Error {
  readonly _tag = "HttpError" as const;
  readonly provider: string;
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly method: string;

  constructor(args: HttpErrorArgs) {
    const method = args.method ?? "GET";
    // URL can carry an `?access_token=`/`?key=` query param; redact it too.
    super(`[${args.provider}] ${method} ${args.status} ${redactSecrets(args.url)} :: ${args.body}`);
    this.name = "HttpError";
    this.provider = args.provider;
    this.status = args.status;
    this.url = args.url;
    this.body = args.body;
    this.method = method;
  }

  /** Worth retrying: rate-limited (429) or a transient upstream 5xx. */
  get retryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

/** Type guard — branch on the tag, not the message. */
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

/**
 * Build an {@link HttpError} from a failed `Response`, reading a bounded +
 * secret-redacted slice of the body. The one-liner that replaces the
 * copy-pasted `if (!res.ok) { const body = await res.text().catch(() => "");
 * throw new Error(...) }` block at every fetch site:
 *
 *   if (!res.ok) throw await httpErrorFromResponse("gmail", res, { url });
 *
 * Reads the body, so only call it on the error path (a non-ok response).
 */
export async function httpErrorFromResponse(
  provider: string,
  res: Response,
  opts: { url?: string; method?: string } = {},
): Promise<HttpError> {
  const raw = await res.text().catch(() => "");
  return new HttpError({
    provider,
    status: res.status,
    url: opts.url ?? res.url,
    method: opts.method,
    body: summarizeBody(raw),
  });
}
