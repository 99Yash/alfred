# Browser security headers (#295)

Alfred serves two browser-facing surfaces from separate Railway services, so the
security-header policy lives in two repo-owned places:

| Surface | Origin | Policy owner | Mechanism |
| --- | --- | --- | --- |
| API | `api.alfred.beauty` | `packages/api/src/middleware/security-headers.ts` | Elysia `onRequest` plugin, wired in `apps/server/src/index.ts` next to CORS |
| Web (SPA) | `alfred.beauty` | root `Caddyfile` | Railpack serves the Vite build with Caddy and uses this file verbatim |

## API (`api.alfred.beauty`)

The API is a JSON/Eden endpoint plus OAuth redirects — it never serves an HTML
document that loads sub-resources, so the CSP is maximally locked down:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload   # production only
```

HSTS is gated on `serverEnv().NODE_ENV === "production"` so it is never sent on
the local http origin. The plugin uses `onRequest` + `set.headers` — the one
mechanism verified to reach every response, including Elysia `onError` responses
and the `.mount()`ed Better Auth handler (see `test/security-headers.test.ts`).

## Web (`alfred.beauty`)

The SPA renders LLM/user content, sandboxed srcdoc iframes (artifacts, email
HTML), OAuth redirects, and cross-origin API calls. The CSP allowlist is derived
from a **live capture of the authenticated app**, not guessed:

- `script-src` — `'self'`, the two first-party inline bootstraps in
  `apps/web/index.html` pinned by SHA-256 (no `'unsafe-inline'`), and
  `us-assets.i.posthog.com` (PostHog config/surveys/recorder).
- `connect-src` — API, PostHog (`us.i` + `us-assets.i`), Sentry
  (`*.ingest.de.sentry.io`), weather/geocode (`open-meteo`, `bigdatacloud`,
  `get.geojs.io`), and R2 (`*.r2.cloudflarestorage.com`) for presigned uploads.
- `style-src` / `img-src` / `font-src` — widened to `https:` so rendered
  artifacts and email HTML (srcdoc iframes inherit the parent CSP) keep their
  external styling and images. These classes can't execute code.
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'` — the high-value clickjacking/injection levers stay tight.
- `Permissions-Policy: geolocation=(self)` — the weather hero reads
  `navigator.geolocation`; dropping to `()` silently forces IP fallback.

### Editing the inline bootstrap scripts

`script-src` pins the anti-FOUC theme stamp and the `vite:preloadError` chunk
recovery script by hash. If you edit either `<script>` in `apps/web/index.html`,
regenerate its hash in the `Caddyfile` or the browser silently blocks it:

```sh
python3 - <<'PY'
import re, hashlib, base64
html = open("apps/web/index.html").read()
for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S):
    print("sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode())
PY
```

## Verification checklist (post-deploy)

Caddy isn't installed in CI, so verify the deployed headers with curl:

```sh
# Web — expect CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS
curl -sI https://alfred.beauty/ | grep -iE 'content-security-policy|x-frame-options|referrer-policy|permissions-policy|strict-transport|x-content-type'

# API — expect the locked-down default-src 'none' CSP + the same companions
curl -sI https://api.alfred.beauty/health | grep -iE 'content-security-policy|x-frame-options|referrer-policy|permissions-policy|strict-transport|x-content-type'
```

Then load `https://alfred.beauty` in a browser and confirm the DevTools console
shows **no CSP violation errors** across: sign-in (Google OAuth), the chat
stream, an artifact preview, an email preview in the inbox, the weather hero
(geolocation prompt), and PostHog/Sentry network calls. A violation there means
a directive is too tight — widen the specific directive, don't fall back to
`'unsafe-inline'`/`*`.
```
