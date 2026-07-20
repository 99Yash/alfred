import { summarizeBody, type RestPassthroughRequest } from "@alfred/contracts";

/**
 * The one authenticated REST transport the general read-only passthrough tier
 * (ADR-0074 rung-a) shares across every REST provider (`github.request`,
 * `notion.request`, `vercel.request`, …). It executes an *already-gated* request
 * with authority + headers pinned by the provider — the model never supplies an
 * origin, host, or header — and returns the real HTTP status plus the parsed
 * body, never throwing on a non-2xx (the honest envelope surfaces API error
 * bodies verbatim). A transport failure (timeout/DNS/reset/TLS) still throws for
 * the caller's adapter to classify.
 *
 * Redirects are never followed (`redirect: "manual"`): a signed provider redirect
 * can carry credentials in its URL, and a read-only passthrough must treat a 3xx
 * as an HTTP outcome, not a hop — any `Location` is redacted to origin + path.
 * Binary bytes never enter the transcript: a non-text response is represented by
 * its content type + byte count.
 *
 * The read gate (which proves the method/path is a read) runs in `@alfred/api`
 * *before* this is ever reached; the namespace re-check here is defense-in-depth
 * on the constructed URL, not the primary boundary.
 */

const REST_TIMEOUT_MS = 30_000;

/**
 * Per-provider transport policy — the data-only inputs pinning authority and
 * auth. Carries no gate policy (that is {@link RestProviderGateConfig} in
 * `@alfred/api`); this is purely "where and as whom the request is sent."
 */
export interface RestPassthroughProfile {
  /**
   * Pinned origin + optional namespace, no trailing slash — e.g.
   * `"https://api.github.com"` or `"https://api.notion.com/v1"`. The request's
   * namespace-relative path is appended to this; the model can never change it.
   */
  baseUrl: string;
  /**
   * Pinned request headers (authorization + provider/version/accept). The model
   * cannot supply headers; `Content-Type` is added by the transport only when a
   * body is sent.
   */
  headers: Record<string, string>;
  /**
   * Provider-mandated query parameters always appended (e.g. Vercel's `teamId`).
   * Applied before the request's own `query`, which cannot override them.
   */
  fixedQuery?: Record<string, string>;
}

/**
 * A completed REST exchange in a shape the result shaper can turn into the honest
 * envelope. `binary: true` carries only the content type + byte count (bytes are
 * omitted from the transcript). `redirectedTo` is set for a 3xx and is already
 * redacted to origin + path.
 */
export type RawRestResponse =
  | { status: number; binary: false; body: unknown; redirectedTo?: string }
  | { status: number; binary: true; contentType: string; byteCount: number; redirectedTo?: string };

/**
 * Thrown when the URL constructed from the profile + request escapes the pinned
 * origin/namespace. Unreachable given the read gate's path hardening; the adapter
 * maps it to a fail-closed `invalid_path` rejection (the request never left
 * Alfred) rather than letting it masquerade as a transport failure.
 */
export class PassthroughUrlError extends Error {
  readonly _tag = "PassthroughUrlError" as const;
  constructor(message: string) {
    super(message);
    this.name = "PassthroughUrlError";
  }
}

/** Build the request URL and re-assert it stays within the pinned namespace. */
function buildAndVerifyUrl(profile: RestPassthroughProfile, request: RestPassthroughRequest): URL {
  const base = new URL(profile.baseUrl);
  const url = new URL(profile.baseUrl + request.path);

  const namespace = base.pathname.replace(/\/$/, "");
  const withinNamespace =
    namespace === "" || url.pathname === namespace || url.pathname.startsWith(`${namespace}/`);
  if (url.origin !== base.origin || !withinNamespace) {
    throw new PassthroughUrlError(
      "The constructed request URL left the pinned API namespace. Use a namespace-relative path.",
    );
  }

  for (const [key, value] of Object.entries(profile.fixedQuery ?? {})) {
    url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function restPassthroughFetch(
  profile: RestPassthroughProfile,
  request: RestPassthroughRequest,
): Promise<RawRestResponse> {
  const url = buildAndVerifyUrl(profile, request);
  const method = request.method.toUpperCase();
  const hasBody = request.body !== undefined && method === "POST";

  const res = await fetch(url, {
    method,
    headers: {
      ...profile.headers,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });

  const redirectedTo =
    res.status >= 300 && res.status < 400
      ? redactLocation(res.headers.get("location"), url)
      : undefined;
  const redirect = redirectedTo !== undefined ? { redirectedTo } : {};
  const contentType = res.headers.get("content-type");

  if (isBinary(contentType)) {
    return {
      status: res.status,
      binary: true,
      contentType: contentType ?? "application/octet-stream",
      byteCount: await byteCountOf(res),
      ...redirect,
    };
  }

  const text = await res.text();
  return { status: res.status, binary: false, body: parseBody(text, contentType), ...redirect };
}

/**
 * Treat a response as binary unless its content type is a textual/JSON one. The
 * common provider APIs answer `application/json`; PDFs, images, archives, and
 * `application/octet-stream` are binary and must not enter the transcript.
 */
function isBinary(contentType: string | null): boolean {
  if (!contentType) return false; // no type (e.g. an empty body) is treated as text
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/")) return false;
  if (type.includes("json")) return false;
  if (type.endsWith("+xml") || type === "application/xml") return false;
  if (type === "application/x-www-form-urlencoded") return false;
  return true;
}

/** Parse a textual body: JSON when the type says so, else the raw (bounded downstream) text. */
function parseBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null;
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const looksJson = type.includes("json") || type === "";
  if (looksJson) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A JSON-labeled body that won't parse (e.g. an HTML 5xx page): keep a
      // bounded, redacted marker instead of dumping raw markup into the transcript.
      return { nonJson: true, preview: summarizeBody(text) };
    }
  }
  return text; // text/* etc. — the result shaper bounds the string.
}

/** Byte count of a binary response: the declared Content-Length, else the observed length. */
async function byteCountOf(res: Response): Promise<number> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared)) return Number(declared);
  return (await res.arrayBuffer()).byteLength;
}

/**
 * Redact a redirect target to origin + path. A signed redirect URL can carry
 * credentials in its query/fragment, so those are dropped; a relative target is
 * resolved against the request URL first.
 */
function redactLocation(location: string | null, base: URL): string {
  if (!location) return "[no location header]";
  try {
    const resolved = new URL(location, base);
    return resolved.origin + resolved.pathname;
  } catch {
    return "[unparseable location]";
  }
}
