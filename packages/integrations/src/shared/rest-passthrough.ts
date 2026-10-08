import {
  normalizeMimeType,
  summarizeBody,
  type RestPassthroughRequest,
  type SupportedRestSlug,
} from "@alfred/contracts";

import { authedFetch } from "./authed-fetch";
import { fetchWithRetry, type RetryPolicy } from "./retry";

/**
 * Read-only passthrough transport for every REST provider (ADR-0074 rung-a).
 * Sends an already-gated request with pinned origin and headers, and returns the real
 * status and body without throwing on a non-2xx. Transport failures still throw.
 *
 * Redirects are not followed: a signed redirect URL can carry credentials.
 * Binary bodies become content type and byte count, never bytes.
 */

/** Where and as whom to send. The read gate is `RestProviderGateConfig` in `@alfred/assistant`. */
export interface RestPassthroughProfile {
  /** Origin plus optional namespace, no trailing slash, e.g. `"https://api.notion.com/v1"`. */
  baseUrl: string;
  /** The model cannot supply headers. */
  headers: Record<string, string>;
  /** Query on every request (Vercel's `teamId`). Set last, so the model cannot override it. */
  fixedQuery?: Record<string, string> | undefined;
}

/** Token-free handle: the API layer gets the slug for its gate and a callable transport. */
export interface RestPassthroughCapability {
  readonly slug: SupportedRestSlug;
  execute(request: RestPassthroughRequest): Promise<RawRestResponse>;
}

export function restPassthroughCapability(args: {
  slug: SupportedRestSlug;
  resolveProfile: () => Promise<RestPassthroughProfile>;
  retry: RetryPolicy | "none";
}): RestPassthroughCapability {
  return {
    slug: args.slug,
    async execute(request) {
      return restPassthroughFetch(await args.resolveProfile(), request, args.retry);
    },
  };
}

/** `redirectedTo` is set on a 3xx, already redacted to origin and path. */
export type RawRestResponse =
  | { status: number; binary: false; body: unknown; redirectedTo?: string }
  | { status: number; binary: true; contentType: string; byteCount: number; redirectedTo?: string };

/**
 * The built URL left the pinned namespace. The read gate should make this unreachable.
 * The adapter maps it to `invalid_path`, not a transport failure.
 */
export class PassthroughUrlError extends Error {
  readonly _tag = "PassthroughUrlError" as const;
  constructor(message: string) {
    super(message);
    this.name = "PassthroughUrlError";
  }
}

/** Defense in depth: the read gate already checked the path. */
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

  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  // `set` replaces any model value for the same key.
  for (const [key, value] of Object.entries(profile.fixedQuery ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
}

export async function restPassthroughFetch(
  profile: RestPassthroughProfile,
  request: RestPassthroughRequest,
  retry: RetryPolicy | "none" = "none",
): Promise<RawRestResponse> {
  const url = buildAndVerifyUrl(profile, request);
  const method = request.method.toUpperCase();

  // Only a read-via-POST carries a body.
  const send = () =>
    authedFetch(
      { headers: profile.headers, redirect: "manual" },
      { url, method, body: method === "POST" ? request.body : undefined },
    );

  // The gate admits only reads (including read-via-POST), so retry is safe here.
  const res = retry === "none" ? await send() : await fetchWithRetry(send, { policy: retry });

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

/** Binary unless the type is text, JSON, XML, or form-encoded. */
function isBinary(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = normalizeMimeType(contentType);

  if (type.startsWith("text/")) return false;

  if (type.includes("json")) return false;

  if (type.endsWith("+xml") || type === "application/xml") return false;

  if (type === "application/x-www-form-urlencoded") return false;

  return true;
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null;
  const type = normalizeMimeType(contentType);
  const looksJson = type.includes("json") || type === "";

  if (looksJson) {
    try {
      return JSON.parse(text);
    } catch {
      // For example an HTML 5xx page labeled JSON.
      return { nonJson: true, preview: summarizeBody(text) };
    }
  }

  return text;
}

async function byteCountOf(res: Response): Promise<number> {
  const declared = res.headers.get("content-length");

  if (declared && /^\d+$/.test(declared)) return Number(declared);

  return (await res.arrayBuffer()).byteLength;
}

/** Drop query and fragment: a signed redirect can carry credentials there. */
function redactLocation(location: string | null, base: URL): string {
  if (!location) return "[no location header]";

  try {
    const resolved = new URL(location, base);

    return resolved.origin + resolved.pathname;
  } catch {
    return "[unparseable location]";
  }
}
