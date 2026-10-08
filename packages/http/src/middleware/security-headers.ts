import { Elysia } from "elysia";

/**
 * Security headers for the API. An `onRequest` hook is the only thing that reaches every
 * response, including `onError` and the mounted Better Auth handler.
 * The API serves no HTML, so the CSP blocks everything.
 */
const STATIC_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  // For older browsers that ignore `frame-ancestors`.
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
} satisfies Readonly<Record<string, string>>;

const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

export interface SecurityHeadersOptions {
  /** HTTPS only: HSTS on a local http origin locks the browser onto https. */
  hsts?: boolean;
}

export function securityHeaders(options: SecurityHeadersOptions = {}): Elysia {
  const headers = options.hsts
    ? { ...STATIC_SECURITY_HEADERS, "Strict-Transport-Security": HSTS_VALUE }
    : { ...STATIC_SECURITY_HEADERS };

  return new Elysia({ name: "security-headers" }).onRequest(({ set }) => {
    Object.assign(set.headers, headers);
  });
}
