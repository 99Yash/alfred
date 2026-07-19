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
import { getPath, isNonEmptyString } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
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
  /**
   * Ordered URLs that issued a redirect on the way to {@link finalUrl} (the
   * "from" of each hop). Present only when the request was redirected, so an
   * `innocuous.com → 302 → attacker.com` hop is auditable in the persisted
   * `action_stagings` row, not just the final URL.
   */
  redirects?: string[];
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
  redirects?: string[];
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
export type Renderer = (
  url: string,
  signal: AbortSignal,
) => Promise<{ text: string; title?: string } | null>;

export interface FetchUrlDeps {
  /** Injectable HTTP seam for the direct fetch (tests). Defaults to {@link safeRequest}. */
  transport?: Transport;
  /** Injectable render seam for the #509/#510 escalation. Defaults to Firecrawl. */
  render?: Renderer;
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
    dispatcher?: Agent;
    signal: AbortSignal;
  },
) => Promise<UndiciResponseLike>;

/** Carries a {@link FetchUrlError} reason out of the transport layer. */
export class FetchError extends Error {
  /** Redirect hops taken before the failure, when any. Set by {@link safeRequest}. */
  redirects?: string[];
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
 * The slice of `dns.lookup` (its `all: true` form) that {@link pinningLookup}
 * depends on. Injectable so tests can drive the connect-time pin with a fake
 * resolver — a resolver returning a private address must surface `EBLOCKEDHOST`
 * — without touching real DNS or opening a socket.
 */
export type DnsLookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  // `addresses` is absent on the error path — `dns.lookup` calls back with just
  // the error there, and the pin only reads addresses when `err` is null.
  callback: (err: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => void,
) => void;

/**
 * Custom DNS lookup for the undici connector: resolve the host, refuse if *any*
 * address is private/internal, and hand back only validated addresses so the
 * socket connects to one of them (connect-time pinning). Supports both the
 * `all:true` (array) and single-address callback shapes Node uses. The resolver
 * is injectable (defaults to `dns.lookup`) purely so the pin is unit-testable.
 */
export function pinningLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void,
  resolve: DnsLookupAll = dns.lookup as DnsLookupAll,
): void {
  resolve(
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
      // `all: true` always calls back with an array on the success path.
      const list = addresses ?? [];
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

/* ── credential-bearing URLs (#293) ───────────────────────────────────── */

/**
 * Full param names that always carry a secret. Matched against the param's
 * percent-decoded, lowercased name (`?Token=` and `?to%6Ben=` both normalize to
 * `token`). `key` / `code` live here as exact-name-only blunt instruments: a bare
 * `?key=`/`?code=` blocks, but `sort_key`/`country_code`/`promo_code` (where the
 * stem is only a *fragment* of a larger word) pass — see {@link CREDENTIAL_SEGMENT_STEMS}.
 */
const CREDENTIAL_EXACT_NAMES = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "authorization",
  "signature",
  "sig",
  "x-amz-signature",
  "x-goog-signature",
  "jwt",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "key",
  "code",
]);

/**
 * Stems that block when they appear as a *whole segment* of a param name.
 * `session-token`, `auth.code`, `X-Amz-Signature`, `accessToken` all split into a
 * segment that hits this set; `monkey`, `keyword`, `authenticationMode` do not
 * (their segments are `monkey` / `keyword` / `authentication`+`mode`). Narrower
 * than {@link CREDENTIAL_EXACT_NAMES}: `key`/`code` are deliberately absent so
 * compound `*_key`/`*_code` params survive.
 */
const CREDENTIAL_SEGMENT_STEMS = new Set(["token", "secret", "signature", "sig", "auth", "jwt"]);

/**
 * Split a param name into lowercase segments on non-alphanumeric boundaries
 * *and* camelCase transitions (`accessToken` → `access`,`token`; `XMLToken` →
 * `xml`,`token`). Segment-aware matching is what keeps `country_code` and
 * `monkey` out of the credential net while still catching `session-token`.
 * The broad separator is intentional: URLSearchParams decodes both `%20` and
 * `+` to a space, so `access%20token` / `access+token` must split too.
 */
function segmentParamName(decoded: string): string[] {
  const boundary = "\u0000";
  return (
    decoded
      .replace(/([a-z0-9])([A-Z])/g, `$1${boundary}$2`) // lower→Upper camelCase boundary
      .replace(/([A-Z]+)([A-Z][a-z])/g, `$1${boundary}$2`) // ACRONYMWord boundary (URLToken)
      // oxlint-disable-next-line no-control-regex -- the U+0000 boundary marker inserted just above
      .split(/[\u0000\W_]+/)
      .map((segment) => segment.toLowerCase())
      .filter((segment) => segment.length > 0)
  );
}

/**
 * Whether a single (already percent-decoded, as `URLSearchParams` yields) param
 * name looks credential-bearing. Exact-name match first, then whole-segment stem
 * match. Never a broad substring test — that's the whole point of the segmenter.
 */
function isCredentialParamName(decodedName: string): boolean {
  if (CREDENTIAL_EXACT_NAMES.has(decodedName.toLowerCase())) return true;
  return segmentParamName(decodedName).some((segment) => CREDENTIAL_SEGMENT_STEMS.has(segment));
}

/** True when any query param name on `u` is credential-bearing. */
function hasCredentialQuery(u: URL): boolean {
  for (const name of u.searchParams.keys()) {
    if (isCredentialParamName(name)) return true;
  }
  return false;
}

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

/**
 * #292: only the scheme's default web port is read. The WHATWG `URL` parser
 * normalizes an explicit `:80`/`:443` that matches the scheme to `""`, so a bare
 * `u.port` is already the default; any non-empty `u.port` is an explicit port and
 * must match the scheme (an `http://h:443` / `https://h:80` mismatch is refused).
 * Closes the SSRF surface where a non-default port reaches an internal service
 * (admin panel, metadata sidecar) on an otherwise-public host.
 */
function hasAllowedDefaultPort(u: URL): boolean {
  if (u.port === "") return true;
  return (
    (u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")
  );
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
  if (!hasAllowedDefaultPort(u)) {
    throw new FetchError(
      "blocked_port",
      `Only default web ports are read; port ${u.port} on '${u.hostname}' is not.`,
      redactCredentialUrl(u.toString()),
    );
  }
  if (hasCredentialQuery(u)) {
    throw new FetchError(
      "credential_url",
      "URLs that carry credentials in the query string are not read.",
      redactCredentialUrl(u.toString()),
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

export function decodeResponseBody(
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
 * return the final response with its body still streaming. The requester is
 * injectable (defaults to undici) so the manual-redirect re-validation — the
 * property that a 302 into private space is refused — is unit-testable without
 * a socket; production always pins via {@link safeAgent}.
 */
export async function safeRequest(
  initialUrl: string,
  signal: AbortSignal,
  doRequest: HttpRequester = undiciRequest as unknown as HttpRequester,
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
        dispatcher: safeAgent(),
        signal,
        // No maxRedirections → undici does NOT auto-follow; we chase 3xx ourselves.
      });
    } catch (err) {
      const chain = redirectChain.length > 0 ? [...redirectChain] : undefined;
      if ((err as NodeJS.ErrnoException)?.code === "EBLOCKEDHOST") {
        const e = new FetchError("blocked_host", (err as Error).message, parsed.toString());
        e.redirects = chain;
        throw e;
      }
      const why = err instanceof Error ? err.message : String(err);
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

  const truncated = out.text.length > MAX_TEXT_CHARS;
  const text = truncated ? out.text.slice(0, MAX_TEXT_CHARS) : out.text;
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
    const why = err instanceof Error ? err.message : String(err);
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
    // A mid-decode error (e.g. corrupt gzip) bypasses readBounded's own
    // destroy(), so free the socket here or it leaks (#286 review).
    await disposeBody(raw.body);
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
