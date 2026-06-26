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
 *     {@link MAX_TEXT_CHARS} with a `truncated` flag the boss can surface.
 *   - NUL-safe: extraction drops control bytes and the platform dispatch-boundary
 *     sanitizer (ADR-0070) strips any residual before persist.
 *
 * SSRF safety — connect-time, not string-deep. Every socket is opened through a
 * custom DNS lookup ({@link pinningLookup}) that resolves the host, rejects the
 * request if *any* resolved address falls in a loopback / link-local / private /
 * CGNAT / multicast / IPv4-mapped range ({@link isBlockedIp}), and pins the
 * connection to that validated address. Because the pin happens at the socket,
 * it covers DNS names that resolve to private space (`127.0.0.1.nip.io`),
 * IPv4-mapped IPv6, and — since redirects are followed *manually*, one validated
 * hop at a time ({@link safeRequest}) — a redirect into internal space. SNI and
 * the `Host` header keep the original hostname, so TLS still validates.
 */

import dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, request as undiciRequest } from "undici";

/** Hard cap on returned text so a large page can't blow the caller's context. */
export const MAX_TEXT_CHARS = 100_000;

/** Stop reading (and tear down the socket) once a body passes this many bytes. */
const MAX_FETCH_BYTES = 8_000_000;

const FETCH_TIMEOUT_MS = 15_000;

/** How many redirect hops we'll chase before giving up. */
const MAX_REDIRECTS = 5;

// A real-ish UA — some sites 403 an unknown agent. Honest about being a bot.
const USER_AGENT = "Mozilla/5.0 (compatible; AlfredBot/1.0; +https://github.com/99Yash/alfred)";

const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5";
const ACCEPT_ENCODING = "br, gzip, deflate";

/** Control bytes to drop from extracted text (keeps tab `\t` and newline `\n`). */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point: we strip them.
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface FetchUrlOk {
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
  /** True when the text was cut off at {@link MAX_TEXT_CHARS}. */
  truncated: boolean;
}

export interface FetchUrlError {
  ok: false;
  url: string;
  finalUrl?: string;
  contentType?: string;
  reason: "blocked_host" | "unsupported_content_type" | "too_large" | "http_error" | "fetch_failed";
  /** A plain-language explanation the boss can relay to the user. */
  message: string;
}

export type FetchUrlResult = FetchUrlOk | FetchUrlError;

export interface FetchUrlArgs {
  url: string;
  abortSignal?: AbortSignal;
}

/* ── host safety ──────────────────────────────────────────────────────── */

type V4Cidr = readonly [base: string, prefixBits: number];

const BLOCKED_V4_CIDRS: readonly V4Cidr[] = [
  ["0.0.0.0", 8], // current network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / broadcast
];

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
}

function ipv4InCidr(value: number, base: string, prefixBits: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const divisor = 2 ** (32 - prefixBits);
  return Math.floor(value / divisor) === Math.floor(baseValue / divisor);
}

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  for (const [base, prefixBits] of BLOCKED_V4_CIDRS) {
    if (ipv4InCidr(value, base, prefixBits)) return true;
  }
  return false;
}

function expandDottedV4Tail(host: string): string {
  const dotted = host.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (!dotted?.[1] || !dotted[2]) return host;
  const parts = dotted[2].split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return host;
  const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
  const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
  return `${dotted[1]}${hi}:${lo}`;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const host = expandDottedV4Tail(ip);
  const pieces = host.split("::");
  if (pieces.length > 2) return null;

  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (left.length + right.length > 8) return null;

  const fill = pieces.length === 2 ? Array(8 - left.length - right.length).fill("0") : [];
  const hextets = [...left, ...fill, ...right];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const part of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    value = (value << 16n) + BigInt(Number.parseInt(part, 16));
  }
  return value;
}

function ipv6InRange(value: bigint, prefix: string, prefixBits: number): boolean {
  const base = ipv6ToBigInt(prefix);
  if (base === null) return false;
  const shift = 128n - BigInt(prefixBits);
  return value >> shift === base >> shift;
}

function isBlockedV6(host: string): boolean {
  const value = ipv6ToBigInt(host);
  if (value === null) return true;

  // Deprecated IPv4-compatible IPv6: ::7f00:1 / ::127.0.0.1. Block the whole
  // special prefix rather than trying to make URL literals in it useful.
  if (ipv6InRange(value, "::", 96)) return true;

  // IPv4-mapped IPv6: ::ffff:7f00:1 -> 127.0.0.1.
  if (ipv6InRange(value, "::ffff:0:0", 96)) {
    const v4 = Number(value & 0xffffffffn);
    return isBlockedV4(
      `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`,
    );
  }

  return (
    value === 0n || // ::/128 unspecified
    value === 1n || // ::1/128 loopback
    ipv6InRange(value, "fc00::", 7) || // unique-local
    ipv6InRange(value, "fe80::", 10) || // link-local
    ipv6InRange(value, "fec0::", 10) || // deprecated site-local
    ipv6InRange(value, "ff00::", 8) || // multicast
    ipv6InRange(value, "64:ff9b:1::", 48) || // local-use NAT64 translation
    ipv6InRange(value, "100::", 64) || // discard-only
    ipv6InRange(value, "2001::", 23) || // IETF protocol assignments
    ipv6InRange(value, "2001:db8::", 32) || // documentation
    ipv6InRange(value, "2002::", 16) || // 6to4 tunnel addresses can embed private IPv4
    ipv6InRange(value, "3fff::", 20) || // documentation
    ipv6InRange(value, "64:ff9b::", 96) // well-known NAT64 IPv4 translation prefix
  );
}

/**
 * Classify a resolved IP literal. Refuses non-public special-use ranges:
 * loopback, link-local (incl. the `169.254.169.254` cloud-metadata IP),
 * private IPv4/IPv6, CGNAT, benchmarking/documentation ranges, multicast,
 * reserved space, and IPv4-mapped / compatible IPv6 private forms. This is the
 * connect-time boundary used by {@link pinningLookup}.
 */
export function isBlockedIp(ip: string): boolean {
  const host = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "") // strip IPv6 brackets
    .replace(/%.*$/, ""); // strip zone id

  // Plain IPv4 literal.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return isBlockedV4(host);

  if (host.includes(":")) {
    if (isIP(host) !== 6) return true;
    return isBlockedV6(host);
  }

  return false; // not an IP literal
}

/**
 * Reject hosts before we even open a socket: loopback / internal names and any
 * IP *literal* in a private range. A bare DNS name (e.g. `127.0.0.1.nip.io`)
 * passes here and is caught at connect time by {@link pinningLookup} once it
 * resolves.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  return isBlockedIp(host);
}

/* ── HTML → text ──────────────────────────────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
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
};

/** Decode the HTML entities a text reader actually encounters. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
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
 * in the head is the catch-all: UTF-8 text never contains one.
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

  // Catch-all: a NUL byte in the head means it isn't UTF-8 text.
  const head = bytes.subarray(0, 1024);
  for (const b of head) if (b === 0) return "application/octet-stream";

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
}

export type Transport = (url: string, signal: AbortSignal) => Promise<RawResponse>;

/** Carries a {@link FetchUrlError} reason out of the transport layer. */
export class FetchError extends Error {
  constructor(
    readonly reason: FetchUrlError["reason"],
    message: string,
    readonly finalUrl?: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * Custom DNS lookup for the undici connector: resolve the host, refuse if *any*
 * address is private/internal, and hand back only validated addresses so the
 * socket connects to one of them (connect-time pinning). Supports both the
 * `all:true` (array) and single-address callback shapes Node uses.
 */
function pinningLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dns.lookup(
    hostname,
    {
      all: true,
      family: (options as dns.LookupOneOptions).family ?? 0,
      hints: options.hints,
      verbatim: true,
    },
    (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const blocked = list.find((a) => isBlockedIp(a.address));
      if (blocked) {
        const e = new Error(
          `'${hostname}' resolves to a private or internal address (${blocked.address}).`,
        ) as NodeJS.ErrnoException;
        e.code = "EBLOCKEDHOST";
        callback(e);
        return;
      }
      const first = list[0];
      if (!first) {
        const e = new Error(`'${hostname}' did not resolve.`) as NodeJS.ErrnoException;
        e.code = "ENOTFOUND";
        callback(e);
        return;
      }
      if ((options as dns.LookupAllOptions).all) {
        callback(null, list);
      } else {
        callback(null, first.address, first.family);
      }
    },
  );
}

let sharedAgent: Agent | undefined;
function safeAgent(): Agent {
  sharedAgent ??= new Agent({
    // Cast: pinningLookup follows dns.lookup's call shape; the connector's
    // LookupFunction type is stricter on the callback's address arg than we need.
    connect: { lookup: pinningLookup as unknown as LookupFunction, timeout: FETCH_TIMEOUT_MS },
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
  });
  return sharedAgent;
}

/** Validate one hop's URL string-deep, before any socket is opened. */
function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("fetch_failed", "The URL is malformed.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError(
      "blocked_host",
      `Only http(s) URLs can be read; '${u.protocol}' is not supported.`,
    );
  }
  if (u.username || u.password) {
    throw new FetchError("blocked_host", "URLs that embed credentials are not read.", u.toString());
  }
  if (isBlockedHost(u.hostname)) {
    throw new FetchError(
      "blocked_host",
      `'${u.hostname}' is a private or internal host and cannot be read.`,
      u.toString(),
    );
  }
  return u;
}

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

function contentCharset(header: string | null | undefined): string | null {
  const match = /(?:^|;)\s*charset\s*=\s*("?)([^";]+)\1/i.exec(header ?? "");
  return match?.[2]?.trim().toLowerCase() || null;
}

async function disposeBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  const disposable = body as {
    destroy?: (err?: Error) => void;
    dump?: (opts?: { limit: number; signal?: AbortSignal }) => Promise<void>;
  };
  if (typeof disposable.destroy === "function") {
    disposable.destroy();
    return;
  }
  if (typeof disposable.dump === "function") {
    try {
      await disposable.dump({ limit: 131_072 });
    } catch {
      // Best-effort cleanup; the original return reason is more useful.
    }
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

function decodeResponseBody(
  body: AsyncIterable<Uint8Array>,
  contentEncoding: string | undefined,
  finalUrl: string,
): { body: AsyncIterable<Uint8Array>; decoded: boolean } {
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
      return stream[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    },
    destroy(err?: Error) {
      stream.destroy(err);
      source.destroy(err);
      for (const decoder of decoders) decoder.destroy(err);
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
 * return the final response with its body still streaming.
 */
async function safeRequest(initialUrl: string, signal: AbortSignal): Promise<RawResponse> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = validateUrl(url);
    let res: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      res = await undiciRequest(parsed.toString(), {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: ACCEPT,
          "accept-encoding": ACCEPT_ENCODING,
          "accept-language": "en-US,en;q=0.9",
        },
        dispatcher: safeAgent(),
        signal,
        // No maxRedirections → undici does NOT auto-follow; we chase 3xx ourselves.
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EBLOCKEDHOST") {
        throw new FetchError("blocked_host", (err as Error).message, parsed.toString());
      }
      const why = err instanceof Error ? err.message : String(err);
      throw new FetchError("fetch_failed", `Could not reach the URL: ${why}`, parsed.toString());
    }

    const location = headerValue(res.headers.location);
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      await disposeBody(res.body); // free the socket before the next hop
      url = new URL(location, parsed).toString();
      continue;
    }

    const contentTypeHeader = headerValue(res.headers["content-type"]);
    const decoded = decodeResponseBody(
      res.body,
      headerValue(res.headers["content-encoding"]),
      parsed.toString(),
    );
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
    };
  }
  throw new FetchError("fetch_failed", `Too many redirects (more than ${MAX_REDIRECTS}).`, url);
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
      const destroy = (body as { destroy?: () => void }).destroy;
      if (typeof destroy === "function") destroy.call(body);
      return { bytes: Buffer.concat(chunks), overflow: true };
    }
    chunks.push(buf);
  }
  return { bytes: Buffer.concat(chunks), overflow: false };
}

/* ── orchestration ────────────────────────────────────────────────────── */

export async function runFetchUrl(
  args: FetchUrlArgs,
  deps: { transport?: Transport } = {},
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
      };
    }
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      url: args.url,
      reason: "fetch_failed",
      message: `Could not reach the URL: ${why}`,
    };
  }

  const { finalUrl, status, contentType, contentLength } = raw;

  if (status < 200 || status >= 400) {
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

  if (contentType && !isTextualType(contentType)) {
    await disposeBody(raw.body);
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType,
      reason: "unsupported_content_type",
      message: `That URL is a ${contentType} resource. This tool reads web pages in as text; it does not download binaries (PDFs, images, archives).`,
    };
  }

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
    const why = err instanceof Error ? err.message : String(err);
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

  // Sniff before decoding — a binary body with a missing or lying Content-Type
  // would otherwise inline as mojibake (#267).
  const sniffed = sniffBinaryType(bytes);
  if (sniffed) {
    return {
      ok: false,
      url: args.url,
      finalUrl,
      contentType: contentType || sniffed,
      reason: "unsupported_content_type",
      message: `That URL is a binary resource (looks like ${sniffed}). This tool reads web pages in as text; it does not download binaries.`,
    };
  }

  const decoded = decodeText(bytes, raw.charset);
  const looksHtml =
    isHtmlType(contentType) ||
    (!contentType && /<(?:!doctype html|html[\s>])/i.test(decoded.slice(0, 1024)));
  const title = looksHtml ? extractTitle(decoded) : undefined;
  const body = looksHtml ? htmlToText(decoded) : decoded.replace(CONTROL_BYTES, "").trim();

  const truncated = body.length > MAX_TEXT_CHARS;
  const text = truncated ? body.slice(0, MAX_TEXT_CHARS) : body;

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
