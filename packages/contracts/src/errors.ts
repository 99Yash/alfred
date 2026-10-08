/** Shared error helpers: error text, safe upstream bodies, and a structured `HttpError`. */

import { isIndexable } from "./guards";

/** Max chars of an upstream error body to keep. */
export const MAX_ERROR_BODY_CHARS = 500;

/** Get a message string from any thrown value. */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cause links to follow, head included. The deepest real chain is SDK error, fetch failed, errno. */
export const MAX_CAUSE_CHAIN_DEPTH = 4;

/**
 * The error and its causes, nearest first.
 * The MCP SDK puts the cause on `data.cause`, not `cause`, so this reads both.
 */
export function causeChain(err: unknown, maxDepth: number = MAX_CAUSE_CHAIN_DEPTH): unknown[] {
  const chain: unknown[] = [err];
  let cause: unknown = err instanceof Error ? causeOf(err) : undefined;

  for (let depth = 1; depth < maxDepth && cause !== undefined; depth += 1) {
    chain.push(cause);
    cause = cause instanceof Error ? causeOf(cause) : undefined;
  }

  return chain;
}

function causeOf(err: Error): unknown {
  if (err.cause !== undefined) return err.cause;
  // SAFETY: the MCP SDK sets `data` on `SdkError`. This only checks presence.
  const data: unknown = (err as { readonly data?: unknown }).data;

  if (!isIndexable(data)) return undefined;

  return Reflect.get(data, "cause");
}

/** Remove likely secrets (auth headers, `key: value` tokens, URL userinfo) from log text. Not exhaustive. */
export function redactSecrets(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
      .replace(
        /\b(access_token|refresh_token|client_secret|api[-_]?key|apikey|authorization|password|secret|token)\b(\s*["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/gi,
        "$1$2[redacted]",
      )
      // `https://user:token@host`: the key=value pass cannot see a positional secret.
      .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
  );
}

/** Redact, then truncate with a visible marker. */
export function summarizeBody(text: string, max: number = MAX_ERROR_BODY_CHARS): string {
  const redacted = redactSecrets(text);

  if (redacted.length <= max) return redacted;

  return `${redacted.slice(0, max)}…[+${redacted.length - max} chars]`;
}

interface HttpErrorArgs {
  provider: string;
  status: number;
  url: string;
  /** Already passed through `summarizeBody`. */
  body: string;
  /** Defaults to `GET`. */
  method?: string | undefined;
}

/** A failed upstream HTTP response. Branch on its fields, not on the message text. */
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

  /** 429 or 5xx. */
  get retryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }

  /** The provider rejected this input, so a retry of the same request always fails. */
  get perInputPermanent(): boolean {
    return PER_INPUT_PERMANENT_STATUSES.has(this.status);
  }
}

/**
 * Statuses that mean the input itself is bad, so the caller must change it.
 * 401, 403, 404, and 408 are left out: they hit every request until the
 * condition clears, so the input is not at fault.
 */
export const PER_INPUT_PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

/**
 * `omit` drops the body for providers that can echo user content redaction
 * cannot catch, such as a Notion page slice.
 */
export type ErrorBodyPolicy = "summarize" | "omit";

/** Build an `HttpError` from a failed `Response`. It reads the body, so call it only when `!res.ok`. */
export async function httpErrorFromResponse(
  provider: string,
  res: Response,
  opts: {
    url?: string | undefined;
    method?: string | undefined;
    bodyPolicy?: ErrorBodyPolicy | undefined;
  } = {},
): Promise<HttpError> {
  const raw = await res.text().catch(() => "");

  return new HttpError({
    provider,
    status: res.status,
    url: opts.url ?? res.url,
    method: opts.method,
    body: opts.bodyPolicy === "omit" ? "" : summarizeBody(raw),
  });
}
