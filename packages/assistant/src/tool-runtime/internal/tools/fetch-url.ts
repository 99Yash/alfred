/**
 * `system.fetch_url`: read one URL in as sanitized, size-bounded text (ADR-0071).
 * PDFs are extracted. Other binaries are refused, found by sniffing bytes, not
 * by trusting `Content-Type`.
 *
 * SSRF: every socket goes through {@link createPinnedDispatcher}, which refuses a
 * private address at connect time. Redirects are followed manually, one
 * validated hop at a time ({@link safeRequest}).
 */

import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  FETCH_URL_MAX_TEXT_CHARS,
  collapseWhitespace,
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

/** Stop reading and close the socket once a body passes this many bytes. */
const MAX_FETCH_BYTES = REALTIME_PDF_EXTRACTION_LIMITS.fetchUrl.maxBytes;

const FETCH_TIMEOUT_MS = 15_000;

const MAX_REDIRECTS = 5;

// Some sites 403 an unknown agent.
const USER_AGENT = "Mozilla/5.0 (compatible; AlfredBot/1.0; +https://github.com/99Yash/alfred)";

const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5";

const ACCEPT_ENCODING = "br, gzip, deflate";

/** Fewer non-whitespace chars than this reads as `empty_content` (#509). */
const MIN_READABLE_CHARS = 20;

/** ...but only for markup this large, so a tiny stub page stays a normal empty read. */
const NONTRIVIAL_HTML_BYTES = 500;

/** Keeps tab and newline. */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point: we strip them.
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

interface FetchUrlOk {
  ok: true;
  url: string;
  /** After redirects. */
  finalUrl: string;
  /** Bare MIME type, no params. */
  contentType: string;
  title?: string;
  text: string;
  chars: number;
  truncated: boolean;
  /** Each redirecting URL in order, so a hop to another host is auditable. */
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
    // A 200 with markup but no text: a client-rendered app (#509).
    | "empty_content";
  /** Plain language the boss can relay to the user. */
  message: string;
  redirects?: string[] | undefined;
}

export type FetchUrlResult = FetchUrlOk | FetchUrlError;

export interface FetchUrlArgs {
  url: string;
  abortSignal?: AbortSignal;
}

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

      // Reject surrogates: `&#xD800;` would decode to invalid UTF-16.
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

/** Strip HTML to readable text. A regex transform, not a parser. */
export function htmlToText(html: string): string {
  let s = html;

  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Drop elements whose contents are not page copy.
  s = s.replace(
    /<(script|style|head|noscript|svg|template|iframe|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  // An unclosed script or style left here would leak its body, so strip to the end.
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*$/gi, " ");

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");

  s = s.replace(
    /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|tr|table|blockquote|pre|figure|figcaption|dd|dt|dl)\b[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<\/(td|th)>/gi, "\t");

  s = s.replace(/<[^>]+>/g, " ");

  s = decodeEntities(s);
  s = s.replace(CONTROL_BYTES, ""); // drop control noise (boundary sanitizer also runs)
  s = s.replace(/[^\S\n]+/g, " "); // collapse runs of spaces/tabs, keep newlines
  s = s.replace(/ *\n */g, "\n"); // trim each line
  s = s.replace(/\n{3,}/g, "\n\n"); // cap blank-line runs

  return s.trim();
}

/** Read `<title>` before {@link htmlToText} drops `<head>`. */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);

  if (!m?.[1]) return undefined;
  // Quirk: folding before the decode leaves an entity newline (`&#10;`) mid-title.
  const title = decodeEntities(collapseWhitespace(m[1])).trim();

  return title.length > 0 ? title.slice(0, 500) : undefined;
}

/* ── content typing ───────────────────────────────────────────────────── */

function bareContentType(header: string | null | undefined): string {
  return (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Content types read in as text. */
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

/** A best-guess MIME type for a binary body, or `null` for text. */
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

  // UTF-8 text never contains a NUL.
  if (bytes.includes(0)) return "application/octet-stream";

  return null;
}

/* ── safe HTTP transport ──────────────────────────────────────────────── */

/** The transport result. Tests stub this seam. */
export interface RawResponse {
  finalUrl: string;
  status: number;
  /** Bare MIME type, lowercased. */
  contentType: string;
  charset: string | null;
  contentLength: number | null;
  body: AsyncIterable<Uint8Array>;
  redirectChain?: string[];
}

export type Transport = (url: string, signal: AbortSignal) => Promise<RawResponse>;

/** Render a JS-heavy URL in a headless browser. `null` when unavailable or empty. */
type Renderer = (
  url: string,
  signal: AbortSignal,
) => Promise<{ text: string; title?: string } | null>;

export interface FetchUrlDeps {
  /** Defaults to {@link safeRequest}. */
  transport?: Transport;
  /** Defaults to Firecrawl. */
  render?: Renderer;
  /** Defaults to `extraction({ door: "fetchUrl" })`. */
  media?: Pick<Extraction, "extract">;
}

/** The slice of `undici.request` that {@link safeRequest} uses. */
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

export class FetchError extends Error {
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

/** Redact credential-bearing pairs in a raw `a=b&c=d` segment. */
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
 * Redact credentials in userinfo, query, and fragment. String surgery, so it
 * cannot throw or re-encode. The fragment matters: `#access_token=` reaches the audit row.
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

/** Redact `user:pass@` without re-encoding the URL. */
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

/** The model-facing sentence names the host, port, or scheme so the model knows what to fix. */
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
    // MCP guard codes. The public-URL check does not raise them today.
    case "invalid_origin":
    case "invalid_placement":
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
  // SAFETY: undici's body has optional dump/once/destroy methods its type omits.
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
      // Best-effort cleanup.
    }
  }

  if (typeof disposable.destroy === "function") {
    // Undici can emit an async AbortError after destroy(). Unhandled, it crashes the process.
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
      // SAFETY: the declared type omits `destroy`; presence is probed before the call.
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
 * Follow redirects manually so every hop passes {@link validateUrl} and the
 * pinned connector. Returns the final response with its body still streaming.
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
        // No maxRedirections, so undici does not follow 3xx itself.
      });
    } catch (err) {
      const chain = redirectChain.length > 0 ? [...redirectChain] : undefined;
      // The pinned lookup refused the address. Its message names host and address.
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

      return { bytes: Buffer.alloc(0), overflow: true };
    }

    chunks.push(buf);
  }

  return { bytes: Buffer.concat(chunks), overflow: false };
}

/* ── orchestration ────────────────────────────────────────────────────── */

/** Redact every URL field before the result reaches a trace, transcript, or row (#293). */
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
 * Firecrawl `/v1/scrape` render (#510). Never throws; `null` keeps `empty_content`.
 * Skips {@link safeRequest}: the user URL is a payload Firecrawl opens, not our socket.
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

  const markdown = getPath(json, "data", "markdown");

  if (!isNonEmptyString(markdown)) return null;
  const title = getPath(json, "data", "metadata", "title");

  return { text: markdown, ...(isNonEmptyString(title) ? { title } : {}) };
};

/** Render the URL. `null` when the renderer yields nothing usable. */
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

  // A client-rendered page reads back empty, so try a headless render (#509/#510).
  // SSRF: `empty_content` only follows a direct fetch that already passed the host guard.
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

  // A 3xx here had no Location.
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
    // A decode error skips readBounded's destroy(), so free the socket here.
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

  // A missing or false Content-Type would otherwise inline binary as mojibake (#267).
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

  // After the sniff, so an `application/octet-stream` PDF still reaches extraction.
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

  // #509: a client-rendered shell must not read as an empty page. Plain text is exempt.
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
      // An unknown label falls back to UTF-8.
    }
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Extract PDF text. Encrypted, scanned, and invalid PDFs return a clear error. */
async function extractPdfFromBytes(
  bytes: Buffer,
  url: string,
  finalUrl: string,
  contentType: string,
  raw: RawResponse,
  injectedMedia?: Pick<Extraction, "extract">,
): Promise<FetchUrlResult> {
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

  // `[page N]` markers per ADR-0091 D4.
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
