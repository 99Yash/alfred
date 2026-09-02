/**
 * `system.fetch_url` — read a URL's contents in as sanitized text (#286,
 * ADR-0071 honest read-in). The companion to `system.web_search`: web_search
 * *discovers* sources for a question; this *reads* a page the agent already
 * holds a link to (from the user, from `read_user_context`, or a prior tool
 * result).
 *
 * Honest read-in posture — the same contract as `drive.export_file`:
 *   - text only: HTML is stripped to readable text, never streamed raw, and a
 *     binary resource (PDF/image/octet-stream) is reported honestly rather than
 *     garbled into mojibake (the #267 poison-pill failure mode). Binaries are
 *     caught by *sniffing the first bytes*, not by trusting `Content-Type` — a
 *     PDF served as `text/html` is still refused.
 *   - size-bounded: the body is *streamed* and the connection is torn down once
 *     it passes {@link MAX_FETCH_BYTES}, so a chunked response with no
 *     `Content-Length` can't blow memory; the readable text is then capped at
 *     {@link FETCH_URL_MAX_TEXT_CHARS} with a `truncated` flag the boss can surface.
 *   - NUL-safe: extraction drops control bytes and the platform dispatch-boundary
 *     sanitizer (ADR-0070) strips any residual before persist.
 *
 * SSRF safety — connect-time, not string-deep. Every socket is opened through a
 * pinned dispatcher ({@link createPinnedDispatcher}) whose DNS lookup resolves
 * the host, rejects the request if *any* resolved address falls in a loopback /
 * link-local / private / CGNAT / multicast / IPv4-mapped range, and pins the
 * connection to that validated address. The classifiers and the lookup live in
 * `connections/hosted-endpoint.ts`, shared with the MCP endpoint guard; this tool
 * owns only the model-facing sentence. Because the pin happens at the socket,
 * it covers DNS names that resolve to private space (`127.0.0.1.nip.io`),
 * IPv4-mapped IPv6, and — since redirects are followed *manually*, one validated
 * hop at a time ({@link safeRequest}) — a redirect into internal space. SNI and
 * the `Host` header keep the original hostname, so TLS still validates.
 */

import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  FETCH_URL_MAX_TEXT_CHARS,
  getPath,
  isNonEmptyString,
  isPdfContentType,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import {
  extraction,
  formatExtractedMediaText,
  mediaFailureMessage,
  REALTIME_PDF_EXTRACTION_LIMITS,
  type Extraction,
} from "@alfred/extraction";
import { request as undiciRequest, type Dispatcher } from "undici";
import {
  createPinnedDispatcher,
  HostedEndpointError,
  hostedEndpointErrorFrom,
  isCredentialParamName,
  validatePublicWebUrl,
} from "../../../connections";

/** Hard cap on returned text so a large page can't blow the caller's context. */
/** Stop reading (and tear down the socket) once a body passes this many bytes. */
const MAX_FETCH_BYTES = REALTIME_PDF_EXTRACTION_LIMITS.fetchUrl.maxBytes;

const FETCH_TIMEOUT_MS = 15_000;

/** How many redirect hops we'll chase before giving up. */
const MAX_REDIRECTS = 5;

// A real-ish UA — some sites 403 an unknown agent. Honest about being a bot.
const USER_AGENT = "Mozilla/5.0 (compatible; AlfredBot/1.0; +https://github.com/99Yash/alfred)";

const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5";
const ACCEPT_ENCODING = "br, gzip, deflate";

/**
 * Below this many non-whitespace characters, an HTML page has effectively no
 * readable copy — treated as {@link FetchUrlError.reason} `"empty_content"`
 * (#509) rather than a successful empty read.
 */
const MIN_READABLE_CHARS = 20;

/**
 * …but only when the raw markup was non-trivial. A tiny real page (a bare
 * redirect stub) is legitimately empty; a client-rendered app ships a large
 * `<script>`-heavy shell. This guards against flagging the former.
 */
const NONTRIVIAL_HTML_BYTES = 500;

/** Control bytes to drop from extracted text (keeps tab `\t` and newline `\n`). */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point: we strip them.
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

interface FetchUrlOk {
  ok: true;
  /** The URL as requested. */
  url: string;
  /** The URL the response actually came from (after any redirects). */
  finalUrl: string;
  /** The bare MIME type of the response (no charset/params). */
  contentType: string;
  /** The page's `<title>`, when one was present. */
  title?: string;
  /** Sanitized, readable text (HTML stripped; plain text passed through). */
  text: string;
  /** Character count of {@link text} after the size bound. */
  chars: number;
  /** True when the text was cut off at {@link FETCH_URL_MAX_TEXT_CHARS}. */
  truncated: boolean;
  /**
   * Ordered URLs that issued a redirect on the way to {@link finalUrl} (the
   * "from" of each hop). Present only when the request was redirected, so an
   * `innocuous.com → 302 → attacker.com` hop is auditable in the persisted
   * `action_stagings` row, not just the final URL.
   */
  redirects?: string[] | undefined;
}

export interface FetchUrlError {
  ok: false;
  url: string;
  finalUrl?: string;
  contentType?: string;
  reason:
    | "blocked_host"
    | "blocked_port"
    | "credential_url"
    | "unsupported_content_type"
    | "too_large"
    | "http_error"
    | "fetch_failed"
    // The page returned a 200 with markup but no extractable text — a
    // client-rendered app whose content needs a browser to run its JS (#509).
    // Distinct from a genuinely empty page so the boss can pivot/relay instead
    // of reading silence as absence.
    | "empty_content";
  /** A plain-language explanation the boss can relay to the user. */
  message: string;
  /** Redirect hops taken before the failure, when any (see {@link FetchUrlOk.redirects}). */
  redirects?: string[] | undefined;
}

export type FetchUrlResult = FetchUrlOk | FetchUrlError;

export interface FetchUrlArgs {
  url: string;
  abortSignal?: AbortSignal;
}

/* ── host safety ──────────────────────────────────────────────────────── */

/* ── HTML → text ──────────────────────────────────────────────────────── */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
} satisfies Record<string, string>;

/** Decode the HTML entities a text reader actually encounters. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Reject the surrogate range (0xD800–0xDFFF): `&#xD800;` would otherwise
      // decode to a lone surrogate, leaving invalid UTF-16 for downstream code
      // to trip over rather than relying on the boundary sanitizer to scrub it.
      if (
        Number.isFinite(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = Object.entries(NAMED_ENTITIES).find(
      ([entity]) => entity === body.toLowerCase(),
    )?.[1];
    return named ?? whole;
  });
}

/**
 * Strip an HTML document to readable text. Not a full parser — a deterministic,
 * dependency-free transform tuned for "read the copy off this page": drop
 * non-content elements, turn block boundaries into line breaks, unwrap the rest,
 * decode entities, and normalize whitespace.
 */
export function htmlToText(html: string): string {
  let s = html;

  // 1. Comments and CDATA.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Elements whose *contents* are not page copy — drop tag + body wholesale.
  s = s.replace(
    /<(script|style|head|noscript|svg|template|iframe|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  // The pair above needs a closing tag; a content-free element left unclosed
  // (truncated mid-stream or malformed) would otherwise leak its body as text.
  // Any such opening tag still here is unterminated — strip it to end of input.
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*$/gi, " ");

  // 3. List items → "- " bullets; line breaks → newlines.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");

  // 4. Block-level boundaries → a newline so paragraphs don't run together.
  s = s.replace(
    /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|tr|table|blockquote|pre|figure|figcaption|dd|dt|dl)\b[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<\/(td|th)>/gi, "\t");

  // 5. Unwrap every remaining tag.
  s = s.replace(/<[^>]+>/g, " ");

  // 6. Decode entities, then normalize whitespace.
  s = decodeEntities(s);
  s = s.replace(CONTROL_BYTES, ""); // drop control noise (boundary sanitizer also runs)
  s = s.replace(/[^\S\n]+/g, " "); // collapse runs of spaces/tabs, keep newlines
  s = s.replace(/ *\n */g, "\n"); // trim each line
  s = s.replace(/\n{3,}/g, "\n\n"); // cap blank-line runs

  return s.trim();
}

/** Pull the `<title>` out of raw HTML (before {@link htmlToText} drops `<head>`). */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  const title = decodeEntities(m[1].replace(/\s+/g, " ")).trim();
  return title.length > 0 ? title.slice(0, 500) : undefined;
}

/* ── content typing ───────────────────────────────────────────────────── */

function bareContentType(header: string | null | undefined): string {
  return (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Content types we read in as text. Everything else is reported, not garbled. */
function isTextualType(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/ld+json" ||
    mime === "application/rss+xml" ||
    mime === "application/atom+xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function isHtmlType(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

/**
 * Sniff the leading bytes for a binary resource that a `Content-Type` might be
 * lying about (a PDF served as `text/html`, etc.). Returns a best-guess MIME
 * label when the body is binary, or `null` when it reads as text. A single NUL
 * in the bounded body is the catch-all: UTF-8 text never contains one.
 */
function sniffBinaryType(bytes: Buffer): string | null {
  if (bytes.length === 0) return null;
  const has = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  const text = (s: string): boolean => has(...[...s].map((c) => c.charCodeAt(0)));

  if (text("%PDF")) return "application/pdf";
  if (has(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (text("GIF87a") || text("GIF89a")) return "image/gif";
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06)) return "application/zip";
  if (has(0x1f, 0x8b)) return "application/gzip";
  if (has(0x42, 0x5a, 0x68)) return "application/x-bzip2"; // BZh
  if (has(0x7f, 0x45, 0x4c, 0x46)) return "application/x-elf";
  if (text("RIFF")) return "application/octet-stream"; // wav/webp/avi
  if (text("OggS")) return "application/ogg";
  if (has(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";

  // Catch-all: a NUL byte anywhere in the bounded body means it isn't UTF-8 text.
  if (bytes.includes(0)) return "application/octet-stream";

  return null;
}

/* ── safe HTTP transport ──────────────────────────────────────────────── */

/** Normalized response handed to {@link runFetchUrl} — the seam unit tests stub. */
export interface RawResponse {
  finalUrl: string;
  status: number;
  /** Bare MIME type (no params), lowercased. */
  contentType: string;
  /** Charset parsed from Content-Type, when supplied by the server. */
  charset: string | null;
  contentLength: number | null;
  body: AsyncIterable<Uint8Array>;
  /** URLs that issued a redirect en route to {@link finalUrl}, in order. */
  redirectChain?: string[];
}

export type Transport = (url: string, signal: AbortSignal) => Promise<RawResponse>;

/**
 * Renders a JS-heavy URL through a headless browser and returns its extracted
 * text, or `null` when rendering is unavailable (no key) or yields nothing.
 * Injectable so tests don't hit the network.
 */
type Renderer = (
  url: string,
  signal: AbortSignal,
) => Promise<{ text: string; title?: string } | null>;

export interface FetchUrlDeps {
  /** Injectable HTTP seam for the direct fetch (tests). Defaults to {@link safeRequest}. */
  transport?: Transport;
  /** Injectable render seam for the #509/#510 escalation. Defaults to Firecrawl. */
  render?: Renderer;
  /**
   * Injectable door-bound extraction seam. Defaults to
   * `extraction({ door: "fetchUrl" })`. Tests inject the same `extract`
   * shape the facade returns — there is no second, legacy seam.
   */
  media?: Pick<Extraction, "extract">;
}

/** The slice of `undici.request` {@link safeRequest} uses — injectable for tests. */
export interface UndiciResponseLike {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
}
export type HttpRequester = (
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    dispatcher?: Dispatcher;
    signal: AbortSignal;
  },
) => Promise<UndiciResponseLike>;

/** Wrap undici's `request` to match the {@link HttpRequester} shape. */
function asHttpRequester(fn: typeof undiciRequest): HttpRequester {
  return (url, opts) =>
    fn(url, {
      method: opts.method,
      headers: opts.headers,
      ...(opts.dispatcher != null && { dispatcher: opts.dispatcher }),
      signal: opts.signal,
    });
}

/** Carries a {@link FetchUrlError} reason out of the transport layer. */
export class FetchError extends Error {
  /** Redirect hops taken before the failure, when any. Set by {@link safeRequest}. */
  redirects?: string[] | undefined;
  constructor(
    readonly reason: FetchUrlError["reason"],
    message: string,
    readonly finalUrl?: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

let sharedDispatcher: Dispatcher | undefined;
function safeDispatcher(): Dispatcher {
  // One page read: every phase is bounded by the tool's own deadline.
  sharedDispatcher ??= createPinnedDispatcher({
    timeouts: {
      headersMs: FETCH_TIMEOUT_MS,
      bodyMs: FETCH_TIMEOUT_MS,
      connectMs: FETCH_TIMEOUT_MS,
    },
  });
  return sharedDispatcher;
}

/* ── credential-bearing URLs (#293) ───────────────────────────────────── */

/**
 * Full param names that always carry a secret. Matched against the param's
 * percent-decoded, lowercased name (`?Token=` and `?to%6Ben=` both normalize to
 * `token`). `key` / `code` live here as exact-name-only blunt instruments: a bare
 * `?key=`/`?code=` blocks, but `sort_key`/`country_code`/`promo_code` (where the
 * stem is only a *fragment* of a larger word) pass — see {@link CREDENTIAL_SEGMENT_STEMS}.
 */
/** Redact credential-bearing `key=value` pairs in a raw `a=b&c=d` segment. */
function redactQuerySegment(segment: string): string {
  return segment
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const rawName = pair.slice(0, eq);
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      return isCredentialParamName(name) ? `${rawName}=[REDACTED]` : pair;
    })
    .join("&");
}

/**
 * Redact credential-like values in URL userinfo plus **query and fragment** params
 * to `[REDACTED]`, keeping scheme/host/path and every non-credential param
 * verbatim. Pure string surgery (no `new URL` round-trip) so it can't throw on a
 * malformed input and never re-encodes the parts it leaves alone. The fragment is
 * covered too: an OAuth implicit-flow `#access_token=…` never reaches the wire but
 * would still be a secret sitting in a persisted audit row.
 */
export function redactCredentialUrl(raw: string): string {
  const hashIdx = raw.indexOf("#");
  const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null;
  const beforeFragment = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const qIdx = beforeFragment.indexOf("?");
  const query = qIdx >= 0 ? beforeFragment.slice(qIdx + 1) : null;
  const base = redactUrlUserinfo(qIdx >= 0 ? beforeFragment.slice(0, qIdx) : beforeFragment);

  let out = base;
  if (query !== null) out += `?${redactQuerySegment(query)}`;
  if (fragment !== null) out += `#${redactQuerySegment(fragment)}`;
  return out;
}

/** Redact `user:pass@` without parsing/re-encoding the URL. */
function redactUrlUserinfo(base: string): string {
  const schemeIdx = base.indexOf("://");
  if (schemeIdx < 0) return base;
  const authorityStart = schemeIdx + 3;
  const authorityEndRaw = base.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndRaw >= 0 ? authorityStart + authorityEndRaw : base.length;
  const authority = base.slice(authorityStart, authorityEnd);
  const atIdx = authority.lastIndexOf("@");
  if (atIdx < 0) return base;
  return `${base.slice(0, authorityStart)}[REDACTED]@${authority.slice(atIdx + 1)}${base.slice(authorityEnd)}`;
}

/** Validate one hop's URL string-deep, before any socket is opened. */
function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FetchError("fetch_failed", "The URL is malformed.");
  }
  if (parsed.username || parsed.password) {
    throw new FetchError(
      "blocked_host",
      "URLs that embed credentials are not read.",
      redactCredentialUrl(parsed.href),
    );
  }
  try {
    return validatePublicWebUrl(parsed);
  } catch (error) {
    if (!(error instanceof HostedEndpointError)) throw error;
    throw refusalFor(error, parsed);
  }
}

/**
 * The guard owns codes; this tool owns the sentence the model reads. The text
 * names the host, port, or scheme from the URL in hand, because "the endpoint
 * host is private" tells the model nothing about which of its URLs to fix.
 */
function refusalFor(error: HostedEndpointError, url: URL): FetchError {
  const shown = redactCredentialUrl(url.href);
  switch (error.code) {
    case "blocked_scheme":
      return new FetchError(
        "blocked_host",
        `Only http(s) URLs can be read; '${url.protocol}' is not supported.`,
        shown,
      );
    case "blocked_host":
      return new FetchError(
        "blocked_host",
        `'${url.hostname}' is a private or internal host and cannot be read.`,
        shown,
      );
    case "blocked_port":
      return new FetchError(
        "blocked_port",
        `Only default web ports are read; port ${url.port} on '${url.hostname}' is not.`,
        shown,
      );
    case "credential_url":
      return new FetchError(
        "credential_url",
        "URLs that carry credentials in the query string are not read.",
        shown,
      );
    case "malformed_url":
      return new FetchError("fetch_failed", "The URL is malformed.", shown);
    // The public-URL check never pins an origin or follows a redirect; these
    // codes belong to the MCP guard and reach here only if that check grows.
    case "invalid_origin":
    case "origin_mismatch":
    case "redirect_refused":
    case "too_many_redirects":
      return new FetchError("fetch_failed", error.message, shown);
  }
}

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

function contentCharset(header: string | null | undefined): string | null {
  const match = /(?:^|;)\s*charset\s*=\s*("?)([^";]+)\1/i.exec(header ?? "");
  return match?.[2]?.trim().toLowerCase() || null;
}

async function disposeBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  // SAFETY: undici's body carries optional dump/once/destroy lifecycle
  // methods that its published type omits.
  const disposable = body as {
    destroy?: (err?: Error) => void;
    dump?: (opts?: { limit: number; signal?: AbortSignal }) => Promise<void>;
    once?: (event: "error", listener: (err: Error) => void) => unknown;
  };
  if (typeof disposable.dump === "function") {
    try {
      await disposable.dump({ limit: 131_072 });
      return;
    } catch {
      // Best-effort cleanup; the original return reason is more useful.
    }
  }
  if (typeof disposable.destroy === "function") {
    // Undici's BodyReadable can emit an asynchronous AbortError after destroy().
    // This is only cleanup; swallow that event so following a redirect cannot
    // crash the process while trying to free the previous hop's socket.
    disposable.once?.("error", () => {});
    disposable.destroy();
  }
}

function decoderForEncoding(encoding: string): Transform | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "br":
      return createBrotliDecompress();
    case "deflate":
      return createInflate();
    default:
      return null;
  }
}

interface DecodedBody {
  body: AsyncIterable<Uint8Array>;
  decoded: boolean;
}

export function decodeResponseBody(
  body: AsyncIterable<Uint8Array>,
  contentEncoding: string | undefined,
  finalUrl: string,
): DecodedBody {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding.length > 0 && encoding !== "identity");

  if (encodings.length === 0) return { body, decoded: false };
  if (encodings.length > 5) {
    throw new FetchError("fetch_failed", "The URL used too many content encodings.", finalUrl);
  }

  const decoders: Transform[] = [];
  for (let i = encodings.length - 1; i >= 0; i--) {
    const decoder = decoderForEncoding(encodings[i]!);
    if (!decoder) {
      throw new FetchError(
        "fetch_failed",
        `The URL used an unsupported content encoding (${encodings[i]}).`,
        finalUrl,
      );
    }
    decoders.push(decoder);
  }

  const source = Readable.from(body);
  let stream: Readable = source;
  for (const decoder of decoders) stream = stream.pipe(decoder);

  const decodedBody: AsyncIterable<Uint8Array> & { destroy: (err?: Error) => void } = {
    [Symbol.asyncIterator]() {
      // SAFETY: Node streams are runtime AsyncIterables; the DOM type omits it.
      return stream[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    },
    destroy(err?: Error) {
      stream.destroy(err);
      source.destroy(err);
      for (const decoder of decoders) decoder.destroy(err);
      // SAFETY: callers pass bodies whose declared type omits `destroy`;
      // presence is probed before the call.
      const destroySource = (body as { destroy?: (err?: Error) => void }).destroy;
      if (typeof destroySource === "function") destroySource.call(body, err);
    },
  };

  return {
    decoded: true,
    body: decodedBody,
  };
}

/**
 * The real transport: follow redirects manually (no undici interceptor) so every
 * hop runs back through {@link validateUrl} *and* the pinning connector, then
 * return the final response with its body still streaming. The requester is
 * injectable (defaults to undici) so the manual-redirect re-validation — the
 * property that a 302 into private space is refused — is unit-testable without
 * a socket; production always pins via {@link safeDispatcher}.
 */
export async function safeRequest(
  initialUrl: string,
  signal: AbortSignal,
  doRequest: HttpRequester = asHttpRequester(undiciRequest),
): Promise<RawResponse> {
  let url = initialUrl;
  const redirectChain: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = validateUrl(url);
    } catch (err) {
      // A blocked *redirect* target carries the hops that led here.
      if (err instanceof FetchError && redirectChain.length > 0) err.redirects = [...redirectChain];
      throw err;
    }
    let res: UndiciResponseLike;
    try {
      res = await doRequest(parsed.toString(), {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: ACCEPT,
          "accept-encoding": ACCEPT_ENCODING,
          "accept-language": "en-US,en;q=0.9",
        },
        dispatcher: safeDispatcher(),
        signal,
        // No maxRedirections → undici does NOT auto-follow; we chase 3xx ourselves.
      });
    } catch (err) {
      const chain = redirectChain.length > 0 ? [...redirectChain] : undefined;
      // The pinned lookup refused an address at connect time. Its message names
      // the host and the address it resolved to, which is what the model needs.
      const hosted = hostedEndpointErrorFrom(err);
      if (hosted?.code === "blocked_host") {
        const e = new FetchError("blocked_host", hosted.message, parsed.toString());
        e.redirects = chain;
        throw e;
      }
      const why = toMessage(err);
      const e = new FetchError(
        "fetch_failed",
        `Could not reach the URL: ${why}`,
        parsed.toString(),
      );
      e.redirects = chain;
      throw e;
    }

    const location = headerValue(res.headers.location);
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      await disposeBody(res.body); // free the socket before the next hop
      const next = new URL(location, parsed);
      redirectChain.push(parsed.toString());
      // Refuse a redirect that drops TLS — don't silently follow an
      // https → http downgrade into a tamperable plaintext hop.
      if (parsed.protocol === "https:" && next.protocol === "http:") {
        const e = new FetchError(
          "blocked_host",
          "Refused a redirect that downgrades HTTPS to HTTP.",
          next.toString(),
        );
        e.redirects = [...redirectChain];
        throw e;
      }
      url = next.toString();
      continue;
    }

    const contentTypeHeader = headerValue(res.headers["content-type"]);
    let decoded: { body: AsyncIterable<Uint8Array>; decoded: boolean };
    try {
      decoded = decodeResponseBody(
        res.body,
        headerValue(res.headers["content-encoding"]),
        parsed.toString(),
      );
    } catch (err) {
      await disposeBody(res.body);
      if (err instanceof FetchError && redirectChain.length > 0) err.redirects = [...redirectChain];
      throw err;
    }
    return {
      finalUrl: parsed.toString(),
      status: res.statusCode,
      contentType: bareContentType(contentTypeHeader),
      charset: contentCharset(contentTypeHeader),
      contentLength: decoded.decoded
        ? null
        : (() => {
            const n = Number(headerValue(res.headers["content-length"]));
            return Number.isFinite(n) && n >= 0 ? n : null;
          })(),
      body: decoded.body,
      ...(redirectChain.length > 0 ? { redirectChain } : {}),
    };
  }
  const e = new FetchError("fetch_failed", `Too many redirects (more than ${MAX_REDIRECTS}).`, url);
  e.redirects = [...redirectChain];
  throw e;
}

/** Read at most `maxBytes`; report `overflow` if the body had more. */
async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Buffer; overflow: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      // SAFETY: undici's body exposes an optional `destroy` its type omits.
      const destroy = (body as { destroy?: () => void }).destroy;
      if (typeof destroy === "function") destroy.call(body);
      // The caller discards the bytes on overflow (returns `too_large`), so
      // skip the wasted Buffer.concat of everything read so far.
      return { bytes: Buffer.alloc(0), overflow: true };
    }
    chunks.push(buf);
  }
  return { bytes: Buffer.concat(chunks), overflow: false };
}

/* ── orchestration ────────────────────────────────────────────────────── */

/**
 * Redact credential-bearing query/fragment values from every URL-shaped field of
 * a result before it leaves the tool. The tool owns sensitivity (#293): because
 * this happens inside `runFetchUrl`, `span.success(result)` in the dispatcher is
 * auto-redacted, and the result that flows into the transcript/persisted row
 * never carries a secret — even on the fragment path, which is fetched fine
 * (fragments aren't sent to the server) but must not be stored verbatim.
 */
function redactFetchResult(r: FetchUrlResult): FetchUrlResult {
  const redirects = r.redirects?.map(redactCredentialUrl);
  if (r.ok) {
    return {
      ...r,
      url: redactCredentialUrl(r.url),
      finalUrl: redactCredentialUrl(r.finalUrl),
      ...(redirects ? { redirects } : {}),
    };
  }
  return {
    ...r,
    url: redactCredentialUrl(r.url),
    ...(r.finalUrl ? { finalUrl: redactCredentialUrl(r.finalUrl) } : {}),
    ...(redirects ? { redirects } : {}),
  };
}

const FIRECRAWL_TIMEOUT_MS = 30_000;

/**
 * Live Firecrawl `/v1/scrape` render (#510). Runs the page in a headless browser
 * and returns extracted markdown. Returns `null` — never throws to the caller —
 * when no key is configured, the request fails, or the render is empty, so the
 * honest `empty_content` result stands. Firecrawl is a trusted first party (our
 * own key), so this bypasses the SSRF-pinned {@link safeRequest}; the arbitrary
 * user URL is the *payload*, rendered on Firecrawl's side, not a socket we open.
 */
const liveFirecrawlRender: Renderer = async (url, signal) => {
  const env = serverEnv();
  if (!env.FIRECRAWL_API_KEY) return null;
  let res: Response;
  try {
    res = await fetch(`${env.FIRECRAWL_BASE_URL}/v1/scrape`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  // External JSON — validate the shape we read rather than trust it (#286 posture).
  const markdown = getPath(json, "data", "markdown");
  if (!isNonEmptyString(markdown)) return null;
  const title = getPath(json, "data", "metadata", "title");
  return { text: markdown, ...(isNonEmptyString(title) ? { title } : {}) };
};

/**
 * The #509/#510 escalation body: render {@link args.url}, and on a usable result
 * return it as a normal {@link FetchUrlOk} (text capped like the direct path).
 * Returns `null` when the renderer yields nothing, so the caller keeps the
 * honest `empty_content`.
 */
async function renderViaFirecrawl(
  args: FetchUrlArgs,
  deps: FetchUrlDeps,
): Promise<FetchUrlResult | null> {
  const render = deps.render ?? liveFirecrawlRender;
  const signal = args.abortSignal ?? AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS);
  let out: Awaited<ReturnType<Renderer>>;
  try {
    out = await render(args.url, signal);
  } catch {
    return null;
  }
  if (!out || out.text.replace(/\s+/g, "").length < MIN_READABLE_CHARS) return null;

  const truncated = out.text.length > FETCH_URL_MAX_TEXT_CHARS;
  const text = truncated ? out.text.slice(0, FETCH_URL_MAX_TEXT_CHARS) : out.text;
  return {
    ok: true,
    url: args.url,
    finalUrl: args.url,
    contentType: "text/markdown",
    ...(out.title ? { title: out.title } : {}),
    text,
    chars: text.length,
    truncated,
  };
}

export async function runFetchUrl(
  args: FetchUrlArgs,
  deps: FetchUrlDeps = {},
): Promise<FetchUrlResult> {
  const direct = await runFetchUrlImpl(args, deps);

  // #509/#510 — a JS-rendered page (x.com, LinkedIn, many SPAs) reads back
  // empty. Escalate that one honest signal to a headless render+extract pass
  // (Firecrawl) against the SAME URL: general, not per-host. When no renderer is
  // configured, or it also comes back empty, the honest `empty_content` stands
  // so the boss can relay or pivot rather than treat silence as absence.
  //
  // SSRF: escalation only fires on `empty_content`, which the direct fetch only
  // returns after safeRequest already resolved + connect-pinned the host (and
  // every redirect hop) to a public IP and got a 200 HTML shell back. So a URL
  // that reaches Firecrawl has already cleared our host guard — a blocked/
  // private host errors as `blocked_host` upstream and never gets here.
  if (!direct.ok && direct.reason === "empty_content") {
    const rendered = await renderViaFirecrawl(args, deps);
    if (rendered) return redactFetchResult(rendered);
  }

  return redactFetchResult(direct);
}

async function runFetchUrlImpl(
  args: FetchUrlArgs,
  deps: FetchUrlDeps = {},
): Promise<FetchUrlResult> {
  const transport = deps.transport ?? safeRequest;
  const signal = args.abortSignal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let raw: RawResponse;
  try {
    raw = await transport(args.url, signal);
  } catch (err) {
    if (err instanceof FetchError) {
      return {
        ok: false,
        url: args.url,
        ...(err.finalUrl ? { finalUrl: err.finalUrl } : {}),
        reason: err.reason,
        message: err.message,
        ...(err.redirects && err.redirects.length > 0 ? { redirects: err.redirects } : {}),
      };
    }
    const why = toMessage(err);
    return {
      ok: false,
      url: args.url,
      reason: "fetch_failed",
      message: `Could not reach the URL: ${why}`,
    };
  }

  const { finalUrl, status, contentType, contentLength } = raw;

  // A 3xx reaching here already passed safeRequest's redirect-follow, so it had
  // no Location — not a usable page. Treat anything outside 2xx as an error
  // rather than returning a blank body (#286 review).
  if (status < 200 || status >= 300) {
    await disposeBody(raw.body);
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "http_error",
      message: `The page returned ${status}.`,
    };
  }

  // PDFs are handled specially — extract text instead of rejecting.
  const isPdf = isPdfContentType(contentType);

  if (contentLength != null && contentLength > MAX_FETCH_BYTES) {
    await disposeBody(raw.body);
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "too_large",
      message: `That page is ${Math.round(contentLength / 1_000_000)}MB — too large to read in.`,
    };
  }

  let bytes: Buffer;
  let overflow: boolean;
  try {
    ({ bytes, overflow } = await readBounded(raw.body, MAX_FETCH_BYTES));
  } catch (err) {
    // A mid-decode error (e.g. corrupt gzip) bypasses readBounded's own
    // destroy(), so free the socket here or it leaks (#286 review).
    await disposeBody(raw.body);
    const why = toMessage(err);
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "fetch_failed",
      message: `Could not read the response body: ${why}`,
    };
  }

  if (overflow) {
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "too_large",
      message: `That page is larger than ${Math.round(MAX_FETCH_BYTES / 1_000_000)}MB — too large to read in.`,
    };
  }

  // Handle PDFs declared by Content-Type (already passed the earlier check).
  if (isPdf) {
    return await extractPdfFromBytes(
      bytes,
      args.url,
      finalUrl,
      contentType || "application/pdf",
      raw,
      deps.media,
    );
  }

  // Sniff before decoding — a binary body with a missing or lying Content-Type
  // would otherwise inline as mojibake (#267). PDFs are extracted to text.
  const sniffed = sniffBinaryType(bytes);
  if (sniffed) {
    if (isPdfContentType(sniffed)) {
      return await extractPdfFromBytes(
        bytes,
        args.url,
        finalUrl,
        contentType || sniffed,
        raw,
        deps.media,
      );
    }
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType: contentType || sniffed,
      reason: "unsupported_content_type",
      message: `That URL is a binary resource (looks like ${sniffed}). This tool reads web pages in as text; it does not download binaries.`,
    };
  }

  // A generic binary Content-Type can still contain a PDF. Reject a declared
  // binary only after bounded byte sniffing has had the chance to prove that
  // case; otherwise `application/octet-stream` PDFs never reach extraction.
  if (contentType && !isTextualType(contentType)) {
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "unsupported_content_type",
      message: `That URL is a ${contentType} resource. This tool reads web pages in as text; it does not download binaries (images, archives).`,
    };
  }

  const decoded = decodeText(bytes, raw.charset);
  const looksHtml =
    isHtmlType(contentType) ||
    (!contentType && /<(?:!doctype html|html[\s>])/i.test(decoded.slice(0, 1024)));
  const title = looksHtml ? extractTitle(decoded) : undefined;
  const body = looksHtml ? htmlToText(decoded) : decoded.replace(CONTROL_BYTES, "").trim();

  const truncated = body.length > FETCH_URL_MAX_TEXT_CHARS;
  const text = truncated ? body.slice(0, FETCH_URL_MAX_TEXT_CHARS) : body;

  // #509 — a client-rendered SPA (x.com, many JS apps) serves a 200 text/html
  // shell that's almost all <script>, so extraction yields no readable copy. A
  // successful-but-empty read is indistinguishable from a page that genuinely
  // has nothing, so the boss reads "I couldn't read this" as "there's nothing
  // here" and moves on silently. Flag it as a distinct, honest failure: the page
  // HAD markup but no extractable text. Plain-text bodies are exempt — an empty
  // .txt is legitimately empty, not an unrendered app.
  if (
    looksHtml &&
    text.replace(/\s+/g, "").length < MIN_READABLE_CHARS &&
    decoded.trim().length >= NONTRIVIAL_HTML_BYTES
  ) {
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType: contentType || "text/html",
      reason: "empty_content",
      message:
        "This page returned no readable text — it looks like a client-rendered app that needs a browser to run its JavaScript before any content appears. Its text can't be read directly.",
      ...(raw.redirectChain && raw.redirectChain.length > 0
        ? { redirects: raw.redirectChain }
        : {}),
    };
  }

  return {
    ok: true,
    url: args.url,
    finalUrl,
    // Report what we actually saw — never silently default unknown bytes to HTML.
    contentType: contentType || (looksHtml ? "text/html" : "text/plain"),
    ...(title ? { title } : {}),
    text,
    chars: text.length,
    truncated,
    ...(raw.redirectChain && raw.redirectChain.length > 0 ? { redirects: raw.redirectChain } : {}),
  };
}

function decodeText(bytes: Buffer, charset: string | null): string {
  if (charset) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // Unknown labels fall back to UTF-8 rather than failing a readable page.
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Extract text from PDF bytes and return a FetchUrlResult. Handles extraction
 * failures honestly — encrypted, needs-ocr, and invalid PDFs report a clear
 * error rather than silently returning nothing.
 */
async function extractPdfFromBytes(
  bytes: Buffer,
  url: string,
  finalUrl: string,
  contentType: string,
  raw: RawResponse,
  injectedMedia?: Pick<Extraction, "extract">,
): Promise<FetchUrlResult> {
  // One door for prod and tests alike — tests inject the same `extract` shape
  // the door-bound facade returns, so there is no legacy branch to keep in
  // sync with this mapping.
  const media = injectedMedia ?? extraction({ door: "fetchUrl" });
  let mediaResult: Awaited<ReturnType<typeof media.extract>>;
  try {
    mediaResult = await media.extract({ mime: "application/pdf", bytes: new Uint8Array(bytes) });
  } catch (err) {
    return {
      ok: false,
      url,
      finalUrl,
      contentType,
      reason: "fetch_failed",
      message: `Could not extract text from the PDF: ${toMessage(err)}`,
      ...(raw.redirectChain && raw.redirectChain.length > 0
        ? { redirects: raw.redirectChain }
        : {}),
    };
  }
  if (!mediaResult || mediaResult.kind !== "extracted") {
    const message = !mediaResult ? "This PDF cannot be read." : mediaFailureMessage(mediaResult);
    return {
      ok: false,
      url,
      finalUrl,
      contentType,
      reason: "unsupported_content_type",
      message,
      ...(raw.redirectChain && raw.redirectChain.length > 0
        ? { redirects: raw.redirectChain }
        : {}),
    };
  }
  // `[page N]` rendering per ADR-0091 D4; the corpus path keeps the
  // marker-less `content` plus offsets.
  const text = formatExtractedMediaText(mediaResult);
  const truncated = text.length > FETCH_URL_MAX_TEXT_CHARS;
  const finalText = truncated ? text.slice(0, FETCH_URL_MAX_TEXT_CHARS) : text;
  return {
    ok: true,
    url,
    finalUrl,
    contentType,
    text: finalText,
    chars: finalText.length,
    truncated,
    ...(raw.redirectChain && raw.redirectChain.length > 0 ? { redirects: raw.redirectChain } : {}),
  };
}
