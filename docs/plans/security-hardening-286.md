# Security hardening — #292 / #293 / #294 (under #286)

Locked via /grilling on 2026-06-28. **One PR: `fix/286-security-hardening`** covering all
three. Implementation/commit order: **#292 → #293 → #294** (292 lays the per-hop reject
path in `validateUrl` that 293 reuses; 294 is independent and could land any time in the PR).

Source files:
- `packages/api/src/modules/tools/fetch-url.ts` — `validateUrl()` (per-hop, line ~555), `FetchUrlError` union, `runFetchUrl` output.
- `packages/api/src/modules/dispatch/index.ts` — `proposedInput` write (~371), `executeToolWithSpan`/`startToolSpan` input (~772). Hash (~301) + execute stay raw.
- `packages/api/src/modules/me/email-html.ts` — `sanitizeEmailHtml` (inject CSP meta).
- `apps/web/src/routes/-preview-chat/inbox-feed.tsx` — `EmailHtmlFrame` (CSP swap + Load button), Reader `MarkdownRenderer` call.
- `apps/web/src/components/markdown-renderer/index.tsx` — add `images` prop.

---

## #292 — restrict fetch_url to default HTTP(S) ports

Reject any explicit non-default port **and scheme/port mismatches**, in `validateUrl` (so
every redirect hop is covered before its socket opens).

```ts
function hasAllowedDefaultPort(u: URL): boolean {
  if (u.port === "") return true; // WHATWG URL normalizes explicit :80/:443 to "" per scheme
  return (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  );
}
```

- allowed: `http://h`, `http://h:80`, `https://h`, `https://h:443`
- rejected: `http://h:443`, `https://h:80`, any other explicit port
- reason: `blocked_port`, message e.g. "Only default web ports are read."

## #293 — refuse credential-bearing URLs before fetch + redact on persist

**Hard block before socket open. No approval path** (fetch_url is intentionally autonomous;
staging would persist the raw secret or need a one-shot secret store — more machinery than
the boundary needs). A future explicit safe-fetch flow is separate and out of scope.

### Matcher — delimiter-aware, never broad-substring
Normalize each query param **name**: lowercase, percent-decode, split on non-alphanumeric
separators (including decoded `%20` / `+` spaces) and camelCase → segments. Then:
- **Block exact full names:** `token, access_token, refresh_token, id_token, auth,
  authorization, signature, sig, x-amz-signature, x-goog-signature, jwt, secret,
  client_secret, api_key, apikey`.
- **Block stems only as a whole segment:** `token, secret, signature, sig, auth, jwt`
  → `session-token`, `auth.code`, `X-Amz-Signature` block; `monkey`, `keyword`,
  `authenticationMode` don't.
- **`key` / `code` are exact-name-only blunt instruments** → `?key=`/`?code=` block, but
  `sort_key`, `country_code`, `zipcode`, `promo_code`, `keyword` pass.
- `utm_*` and ordinary params always pass.

### URL-part scope
| Part | Block fetch? | Redact on persist? |
|---|---|---|
| `user:pass@host` | yes (already) | yes |
| `?query` credential keys | **yes** (initial + each redirect target, before socket) | yes |
| `#fragment` credential keys | no (never transmitted by undici) | **yes** |
| path | no generic matcher | no generic redaction |

Block runs in `validateUrl` → since `safeRequest` calls `validateUrl(url)` at the top of
each hop, a redirect target with credential query params is refused before its socket opens
automatically. Reason: `credential_url`.

### Redaction wiring (tool owns sensitivity, dispatcher owns sink routing)
- New helper `redactCredentialUrl(str)` — redacts URL userinfo plus credential-like
  **query + fragment** values to `[REDACTED]`, keeps everything else. (Distinct from
  `contracts/errors.ts` `redactSecrets`, which is value-pattern based, not URL-param aware.)
- Add optional `redactInput?(input): input` to the tool/liveTool contract. `fetch_url`
  implements it: `(i) => ({ ...i, url: redactCredentialUrl(i.url) })`.
- **Span/trace input: always** `tool.redactInput?.(input) ?? input`.
- **`proposedInput` write: redact only when `!requiresApproval`** (it doubles as the
  approval-resume payload at dispatch `:470` — redacting a *gated* tool's proposedInput would
  corrupt resume). fetch_url is autonomous so safe; guard is encoded for future gated
  secret-bearing tools. A later `proposed_input_raw`/`_display` split would lift the guard.
- **Hash + execute stay raw** (idempotency intact; runFetchUrl needs the real URL to detect
  & block). Result/error URL fields redacted inside `runFetchUrl`, so `span.success(result)`
  is auto-redacted.

## #294 — Original view must not auto-load sender remote media

CSP-gated `<iframe srcDoc>`, per-message opt-in. No server-strip rewriting, no image proxy.

### Server: bake strict CSP meta **first in `<head>`** (re-inject like `<base>`, since DOMPurify strips `<meta>`)
```
default-src 'none'; img-src data: cid:; media-src 'none'; font-src 'none';
connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'none';
style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';
```
Safe-by-default even if rendered raw. Keep `referrerPolicy="no-referrer"` + `<base target="_blank">` (link-safety AC already satisfied).

### Client: per-message "Display remote media" → re-render that iframe with looser policy
```
img-src http: https: data: cid:; media-src http: https:;
```
(scripts/forms/frames/connect/object stay blocked). State is per-message.

### Reader mode must also make zero remote requests
`normalizeBodyForReader` already strips HTML `<img>`, but markdown `![](https://tracker)` in a
text/plain part would still load. Add an opt-in prop to the shared `MarkdownRenderer`
(`images?: "render" | "alt-text"`, default `"render"` so chat/briefings/artifacts unchanged).
Inbox Reader passes `images="alt-text"`:
```tsx
img: ({ alt }) => (alt ? <span className="italic text-white/55">[{alt}]</span> : null)
```
Never emit an `<img>` in alt-text mode.

---

## FetchUrlError reason union (final)
```ts
reason:
  | "blocked_host"            // private/internal host/IP, unsupported scheme, user:pass@host
  | "blocked_port"            // #292: explicit non-default port / scheme-port mismatch
  | "credential_url"          // #293: credential-like query param (initial or redirect)
  | "unsupported_content_type"
  | "too_large"
  | "http_error"
  | "fetch_failed";
```
No consumer switches exhaustively on `reason` (only the boss reads it + the test file), so
widening is free.

## Tests
- **#292:** initial URL + redirect target with non-default port → `blocked_port` before socket
  (inject `HttpRequester`/resolver via existing seams in `fetch-url.test.ts`).
- **#293:** blocked signed/token URLs, allowed ordinary + `utm_*` URLs, redirect target that
  *adds* a credential param; assert redaction in result/error/redirects + that `proposedInput`
  and span input are redacted while hash/execute see raw. Segmentation cases:
  `monkey`/`keyword`/`country_code` must pass; `session-token`/`auth.code` must block.
- **#294:** browser-verifiable fixture — tracking image URL not requested on Original open;
  requested only after explicit Load; Reader emits no remote request for a markdown-image body.

## Verification items (not design decisions)
- Confirm meta-CSP is honored inside the `allow-same-origin` (no `allow-scripts`) sandbox and
  that `base-uri 'none'` doesn't conflict with the target-only `<base target="_blank">`.
