import dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";

const DEFAULT_MAX_REDIRECTS = 5;
/** How far `hostedEndpointErrorFrom` follows an `Error.cause` chain. */
const MAX_CAUSE_DEPTH = 4;
const HOSTED_ENDPOINT_SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "mcp-session-id",
  "traceparent",
  "tracestate",
  "x-api-key",
]);

export function isHostedEndpointSensitiveHeader(name: string): boolean {
  return HOSTED_ENDPOINT_SENSITIVE_HEADERS.has(name.toLowerCase());
}

function stripHostedEndpointSensitiveHeaders(headers: Headers): void {
  for (const name of HOSTED_ENDPOINT_SENSITIVE_HEADERS) headers.delete(name);
}

export type HostedEndpointErrorCode =
  | "malformed_url"
  | "blocked_scheme"
  | "blocked_host"
  | "blocked_port"
  | "credential_url"
  | "invalid_origin"
  | "origin_mismatch"
  | "redirect_refused"
  | "too_many_redirects";

export class HostedEndpointError extends Error {
  constructor(
    readonly code: HostedEndpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostedEndpointError";
  }
}

const BLOCKED_HOST_ERRNO = "EBLOCKEDHOST";

/**
 * Recover the hosted-endpoint refusal behind whatever wrapped it. A URL-level
 * refusal is thrown as a {@link HostedEndpointError} directly. A DNS-level
 * refusal is minted by `pinningLookup` as a Node errno error (`EBLOCKEDHOST`)
 * because undici's connector only understands that shape, and `fetch` then
 * buries it as the `cause` of a bare `TypeError: fetch failed`. Both are the
 * same fact — this host is blocked — so both come back as `blocked_host`.
 *
 * Returns `null` for anything else so callers keep their own generic text.
 */
export function hostedEndpointErrorFrom(err: unknown): HostedEndpointError | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof HostedEndpointError) return current;
    // SAFETY: `code` is the errno field Node puts on network errors; reading it
    // off an `Error` is a presence check, not a shape assertion.
    if ((current as NodeJS.ErrnoException).code === BLOCKED_HOST_ERRNO) {
      return new HostedEndpointError("blocked_host", current.message);
    }
    current = current.cause;
  }
  return null;
}

type V4Cidr = readonly [base: string, prefixBits: number];

const BLOCKED_V4_CIDRS: readonly V4Cidr[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
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
  return BLOCKED_V4_CIDRS.some(([base, prefixBits]) => ipv4InCidr(value, base, prefixBits));
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
  const pieces = expandDottedV4Tail(ip).split("::");
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
  if (ipv6InRange(value, "::", 96)) return true;
  if (ipv6InRange(value, "::ffff:0:0", 96)) {
    const v4 = Number(value & 0xffffffffn);
    return isBlockedV4(
      `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`,
    );
  }
  return (
    value === 0n ||
    value === 1n ||
    ipv6InRange(value, "fc00::", 7) ||
    ipv6InRange(value, "fe80::", 10) ||
    ipv6InRange(value, "fec0::", 10) ||
    ipv6InRange(value, "ff00::", 8) ||
    ipv6InRange(value, "64:ff9b:1::", 48) ||
    ipv6InRange(value, "100::", 64) ||
    ipv6InRange(value, "2001::", 23) ||
    ipv6InRange(value, "2001:db8::", 32) ||
    ipv6InRange(value, "2002::", 16) ||
    ipv6InRange(value, "3fff::", 20) ||
    ipv6InRange(value, "64:ff9b::", 96)
  );
}

export function isBlockedIp(ip: string): boolean {
  const host = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return isBlockedV4(host);
  if (host.includes(":")) return isIP(host) !== 6 || isBlockedV6(host);
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return isBlockedIp(host);
}

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
const CREDENTIAL_SEGMENT_STEMS = new Set(["token", "secret", "signature", "sig", "auth", "jwt"]);

function segmentParamName(decoded: string): string[] {
  const boundary = "\u0000";
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, `$1${boundary}$2`)
    .replace(/([A-Z]+)([A-Z][a-z])/g, `$1${boundary}$2`)
    .replaceAll(boundary, "-")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

export function isCredentialParamName(name: string): boolean {
  if (CREDENTIAL_EXACT_NAMES.has(name.toLowerCase())) return true;
  return segmentParamName(name).some((segment) => CREDENTIAL_SEGMENT_STEMS.has(segment));
}

export function hasCredentialQuery(url: URL): boolean {
  for (const [name] of url.searchParams) {
    if (isCredentialParamName(name)) return true;
  }
  return false;
}

function parseUrl(input: unknown): URL {
  if (typeof input !== "string" && !(input instanceof URL)) {
    throw new HostedEndpointError("malformed_url", "The endpoint URL is invalid.");
  }
  try {
    return new URL(input instanceof URL ? input.href : input);
  } catch {
    throw new HostedEndpointError("malformed_url", "The endpoint URL is malformed.");
  }
}

export function validatePublicWebUrl(input: unknown): URL {
  const url = parseUrl(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HostedEndpointError("blocked_scheme", "Only HTTP and HTTPS endpoints are allowed.");
  }
  if (url.username || url.password) {
    throw new HostedEndpointError("credential_url", "Endpoint URLs cannot embed credentials.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new HostedEndpointError("blocked_host", "The endpoint host is private or internal.");
  }
  if (url.port !== "") {
    throw new HostedEndpointError("blocked_port", "Only the default web port is allowed.");
  }
  if (hasCredentialQuery(url)) {
    throw new HostedEndpointError("credential_url", "Endpoint URLs cannot carry credentials.");
  }
  return url;
}

/**
 * A malformed stored origin is a bad column value, not a mismatch: it gets its
 * own code so an operator can tell "the row is corrupt" from "the endpoint moved".
 */
function parseExpectedOrigin(input: string): string {
  let origin: URL;
  try {
    origin = new URL(input);
  } catch {
    throw new HostedEndpointError("invalid_origin", "The stored origin is invalid.");
  }
  if (origin.href !== `${origin.origin}/`) {
    throw new HostedEndpointError("invalid_origin", "The stored origin is not an origin.");
  }
  return origin.origin;
}

export function validatePinnedHttpsEndpoint(input: unknown, expectedOrigin: string): URL {
  const url = validatePublicWebUrl(input);
  if (url.protocol !== "https:") {
    throw new HostedEndpointError("blocked_scheme", "Hosted MCP endpoints must use HTTPS.");
  }
  if (url.hash !== "") {
    throw new HostedEndpointError(
      "malformed_url",
      "Hosted MCP endpoints cannot contain fragments.",
    );
  }
  if (url.origin !== parseExpectedOrigin(expectedOrigin)) {
    throw new HostedEndpointError(
      "origin_mismatch",
      "The endpoint does not match its stored origin.",
    );
  }
  return url;
}

export type DnsLookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => void,
) => void;

const systemLookupAll: DnsLookupAll = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback);
};

export function pinningLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void,
  resolve: DnsLookupAll = systemLookupAll,
): void {
  resolve(
    hostname,
    { all: true, family: options.family ?? 0, hints: options.hints, verbatim: true },
    (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const list = addresses ?? [];
      const blocked = list.find((address) => isBlockedIp(address.address));
      if (blocked) {
        // SAFETY: Node network errors carry their machine-readable code on Error.
        const blockedError = new Error(
          `'${hostname}' resolves to a private or internal address (${blocked.address}).`,
        ) as NodeJS.ErrnoException;
        blockedError.code = BLOCKED_HOST_ERRNO;
        callback(blockedError);
        return;
      }
      const first = list[0];
      if (!first) {
        // SAFETY: Node network errors carry their machine-readable code on Error.
        const notFound = new Error(`'${hostname}' did not resolve.`) as NodeJS.ErrnoException;
        notFound.code = "ENOTFOUND";
        callback(notFound);
        return;
      }
      if ("all" in options && options.all) callback(null, list);
      else callback(null, first.address, first.family);
    },
  );
}

function asLookupFunction(resolve: DnsLookupAll): LookupFunction {
  return (hostname, options, callback) =>
    pinningLookup(
      hostname,
      options,
      (error, address, family) => {
        if (error) callback(error, "");
        else callback(null, address ?? "", family);
      },
      resolve,
    );
}

/**
 * The socket-level time policy of one pinned dispatcher. It is a required part
 * of the bind, with no default, because the right numbers differ per owner:
 * `fetch_url` reads one page and bounds every phase at its own deadline; an MCP
 * bundle holds a long-lived list-change stream, so its body timeout must be off
 * (`0`) and the SDK request deadline owns request time instead. A shared
 * constant here silently handed one owner the other's policy.
 */
export interface HostedDispatcherTimeouts {
  /** Time to receive complete response headers. */
  headersMs: number;
  /** Time between body chunks; `0` disables the bound (undici semantics). */
  bodyMs: number;
  /** Time to establish the TCP/TLS connection. */
  connectMs: number;
}

export function createPinnedDispatcher(deps: {
  lookup?: DnsLookupAll;
  timeouts: HostedDispatcherTimeouts;
}): Dispatcher {
  return new Agent({
    connect: {
      lookup: asLookupFunction(deps.lookup ?? systemLookupAll),
      timeout: deps.timeouts.connectMs,
    },
    headersTimeout: deps.timeouts.headersMs,
    bodyTimeout: deps.timeouts.bodyMs,
  });
}

/**
 * The init the guard hands its requester: standard `RequestInit` plus the
 * stream-body flag. `dispatcher` is omitted because @types/node declares it
 * against `undici-types`, which is not assignable from the `undici` package's
 * own `Dispatcher`; {@link dispatcherRequester} re-adds it at the send.
 */
export type GuardedRequestInit = Omit<RequestInit, "dispatcher"> & { duplex?: "half" };

/**
 * Sends one already-validated hop. Production binds this to a pinned dispatcher
 * via {@link dispatcherRequester}; tests pass a fake and never open a socket.
 */
export type GuardedFetchRequester = (input: string, init: GuardedRequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  requester: GuardedFetchRequester;
  expectedOrigin?: string;
  maxRedirects?: number;
}

/** Route every hop through `dispatcher`, so its DNS pin and timeouts apply. */
export function dispatcherRequester(dispatcher: Dispatcher): GuardedFetchRequester {
  return (input, init) => {
    const withDispatcher: GuardedRequestInit & { dispatcher: unknown } = { ...init, dispatcher };
    // SAFETY: Node's Fetch implementation accepts Undici's runtime `dispatcher`
    // extension; the DOM `RequestInit` declaration omits only that extra key.
    return globalThis.fetch(input, withDispatcher as RequestInit);
  };
}

export interface HostedRequestFacts {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
}

/**
 * Flatten the two ways a fetch caller can spell one request (`Request` object
 * or `input + init`) into the facts a policy check reads. `init` wins over the
 * `Request` on every field, matching Fetch's own precedence.
 */
export function requestFacts(
  input: string | URL | Request,
  init: RequestInit | undefined,
): HostedRequestFacts {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return {
    url: request?.url ?? (input instanceof URL ? input.href : String(input)),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    headers,
    body: init?.body ?? request?.body ?? undefined,
  };
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not hide the policy refusal.
  }
}

/**
 * A `fetch` that validates every hop before it is sent. With `expectedOrigin`
 * the whole chain is pinned to one stored origin (MCP protocol traffic);
 * without it any public HTTPS origin is allowed and credentials are stripped
 * when a redirect leaves the current origin (OAuth discovery).
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof globalThis.fetch {
  const expectedOrigin =
    options.expectedOrigin === undefined ? null : parseExpectedOrigin(options.expectedOrigin);
  const { requester } = options;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return async (input, init) => {
    const { url, method, headers, body } = requestFacts(input, init);
    const validate = (candidate: unknown): URL => {
      if (expectedOrigin !== null) return validatePinnedHttpsEndpoint(candidate, expectedOrigin);
      const url = validatePublicWebUrl(candidate);
      if (url.protocol !== "https:") {
        throw new HostedEndpointError("blocked_scheme", "Hosted requests must use HTTPS.");
      }
      if (url.hash !== "") {
        throw new HostedEndpointError("malformed_url", "Hosted requests cannot contain fragments.");
      }
      return url;
    };
    let current = validate(url);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const requestInit: GuardedRequestInit = {
        ...init,
        method,
        headers,
        ...(body != null ? { body, duplex: "half" } : {}),
        redirect: "manual",
      };
      const response = await requester(current.href, requestInit);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return response;

      if (init?.redirect === "manual") return response;

      await cancelResponse(response);
      if (method !== "GET" && method !== "HEAD") {
        throw new HostedEndpointError(
          "redirect_refused",
          `A redirected ${method} request is not replayed.`,
        );
      }
      if (hop === maxRedirects) {
        throw new HostedEndpointError(
          "too_many_redirects",
          "The endpoint redirected too many times.",
        );
      }
      const next = validate(new URL(location, current));
      if (next.origin !== current.origin) {
        stripHostedEndpointSensitiveHeaders(headers);
      }
      current = next;
    }
    throw new HostedEndpointError("too_many_redirects", "The endpoint redirected too many times.");
  };
}
