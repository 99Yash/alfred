import { Elysia } from "elysia";

/**
 * Browser security headers for the API surface (#295).
 *
 * Applied like `@elysiajs/cors`: an `onRequest` hook that writes to
 * `set.headers`, which is the one mechanism in this app that reaches *every*
 * response — normal routes, `onError` responses, and the `.mount()`ed Better
 * Auth handler alike (verified in `test/security-headers.test.ts`).
 *
 * The policy is scoped to what the API actually is: a JSON/Eden endpoint plus
 * OAuth redirects. It never serves an HTML document that loads sub-resources,
 * so the CSP locks everything down (`default-src 'none'`) — that neutralizes
 * any response a browser might mis-render as HTML without touching the JSON
 * responses the SPA consumes cross-origin. The page-level CSP that governs the
 * web app itself lives with the web host (see `apps/web/Caddyfile`).
 */

/**
 * Static headers set on every response. HSTS is added separately since it must
 * only be sent over HTTPS (production) — a stale `max-age` on a local http
 * origin would wedge the browser onto https for a port that serves plain http.
 */
const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // A JSON API renders nothing; deny every resource class so a mis-typed or
  // injected HTML response can neither load scripts nor be embedded.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  // Belt-and-suspenders with `frame-ancestors 'none'` for older browsers.
  "X-Frame-Options": "DENY",
  // Never let a browser MIME-sniff a JSON body into something executable.
  "X-Content-Type-Options": "nosniff",
  // Send origin only on cross-origin navigations; never the full path/query.
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // The API needs none of these powerful features.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
};

/** Two years, subdomains, preload-eligible — the standard strong HSTS value. */
const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

export interface SecurityHeadersOptions {
  /**
   * Emit `Strict-Transport-Security`. Only enable where the edge serves HTTPS
   * (production); the caller passes `serverEnv().NODE_ENV === "production"`.
   */
  hsts?: boolean;
}

export function securityHeaders(options: SecurityHeadersOptions = {}): Elysia {
  const headers: Record<string, string> = { ...STATIC_SECURITY_HEADERS };
  if (options.hsts) headers["Strict-Transport-Security"] = HSTS_VALUE;

  return new Elysia({ name: "security-headers" }).onRequest(({ set }) => {
    Object.assign(set.headers, headers);
  });
}
