# Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with Google as the sole social provider and the email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`. Google is the only sign-in method; there is no email/OTP path.

The allowlist rejects any signup whose email is not in `ALFRED_ALLOWED_EMAIL` — a comma-separated list parsed (in `packages/env`) into a normalized, lowercased array (a single email is still valid). It throws, which Better Auth converts to a 422. The hook runs for Google signups too — only an allowlisted Google account can sign in.

`packages/auth/src/session.ts` exports `sessionAuth()` — a lightweight instance for session-only verification (no social providers, no plugins). Nothing in `src/` calls it today; `session-cache.ts` reads sessions through `auth()`. It stays because it takes the same rate-limit and session blocks, so it is ready to serve a session-only process.

In route handlers, call `getSessionCached(request)` from `packages/http/src/middleware/session-cache.ts` — never `auth().api.getSession()` directly.

## Session lifetime

`packages/auth/src/session-policy.ts` holds the `session` block that both instances take (#454). Before it, Alfred set no block, so Better Auth's defaults applied and nothing recorded a decision. Three of the four numbers restate a default. The fourth is new.

| Number         | Value   | What it does                                                                     |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| `expiresIn`    | 7 days  | The idle window. Leave Alfred alone this long and the cookie dies.               |
| `updateAge`    | 1 day   | The slide step. Better Auth pushes `expires_at` forward at most this often.       |
| `freshAge`     | 1 day   | How long after sign-in Better Auth still calls the session "fresh".              |
| absolute cap   | 30 days | The hard ceiling, measured from sign-in. No amount of use extends it.            |

The slide makes the real idle window 6 to 7 days, not exactly 7. Better Auth rewrites `expires_at` to "now + 7 days" only when the row was last rewritten at least one day ago.

**The absolute cap is Alfred's own code, not a Better Auth option.** Better Auth slides `expires_at` forward for ever and offers no total bound, so a cookie in continuous use renews itself without limit. `getSessionCached` applies the cap on every read. Past the cap it **deletes the session row** rather than refusing one request: Better Auth's own mounted routes read that row and nothing else, so the delete is what makes the cap hold on paths the cache never sees. `session.created_at` is the origin, and no refresh path writes it — the slide touches `expires_at` and `updated_at` only.

One gap stays open on purpose. A stolen cookie that only replays Better Auth's own management routes (`/list-sessions`, `/revoke-session`, `/update-user`) and never touches an Alfred route misses the cap, because nothing calls `getSessionCached`. Those routes reach no mail, no Drive, and no Alfred data. The web app calls `/api/auth/get-session` on load and on focus, and that route does go through the cap.

**There is no freshness gate in front of Alfred's write tools, and that is a decision.** Better Auth measures `freshAge` from `session.created_at`, which no refresh moves, so a session can never become fresh again — only a new sign-in is fresh. Google is the sole sign-in path, so the gate could only ever be satisfied by a full OAuth round trip. Worse, the largest blast radius is the wrong side of the gate: briefings, triage, and every autonomous write run from the job queue with no session at all. The gate would add friction to chat and miss the background agent. Revisit it only together with a second sign-in path.

`freshAge` is still load-bearing for Better Auth's own routes. `/list-sessions` and `/update-user` refuse a session older than one day. `/revoke-sessions` and `/revoke-other-sessions` do not, which is why the Settings control below works from a session of any age, and why that control shows no device count next to it.

### Sign out everywhere

Settings holds a "Sign out everywhere else" control (`apps/web/src/routes/-settings/user-section.tsx`). It calls Better Auth's `revokeOtherSessions()`, which deletes every session on the account except the caller's own.

The 10-second session cache (`packages/http/src/middleware/session-cache.ts`) would otherwise delay that revocation. The cache is keyed by token, and this control revokes tokens the request does not carry, so `invalidateSessionToken` cannot reach them. The root app therefore calls `clearSessionTokenCache()` after a successful POST to `/revoke-session`, `/revoke-sessions`, or `/revoke-other-sessions`. Alfred has one user, so dropping the whole map costs one extra database read per live token.

Two limits remain. The clear runs in the process that served the request, so a second API replica keeps its own copy for up to 10 seconds. And `/sign-out` still uses the narrow `invalidateSessionToken`, because it revokes the caller's own token, which the request does carry.

### Cookie prefix

The session cookie carries the `__Secure-` name prefix in production: `__Secure-better-auth.session_token`. Better Auth adds it whenever secure cookies are on, and `advanced.useSecureCookies` now states that condition explicitly in both instances. The option matters because `auth()` passes no `baseURL` and `sessionAuth()` passes one, and Better Auth reads the two differently. Left implicit, the two instances can look for different cookie names.

`__Host-` is stronger and is not reachable. Better Auth never writes it, and its cookie reader looks for `__Secure-<name>` or the bare name only. A `__Host-` name forced through `advanced.cookies` would be a cookie Better Auth itself could no longer read.

## Rate limiting

Both instances take the same `rateLimit` block from `packages/auth/src/rate-limit.ts` (#458). It is on in production only, and it counts in Redis rather than in the API process, so a restart or a second replica cannot reset the counter.

Three things about it are load-bearing.

- **Per-endpoint limits are Better Auth's own.** `/sign-in`, `/sign-up`, `/change-password` and `/change-email` are 3 requests per 10s; the password-reset and verification-email paths are 3 per 60s. A `customRules` entry for a path REPLACES that stricter rule, so the block declares none.
- **A Redis outage degrades, it does not disable.** Each counter falls back to a per-process `Map` and logs one warning per request. That is the limiter Better Auth would run on its own — the limit never lifts, and an outage never locks the only user out of the sign-in path.
- **`advanced.ipAddress.trustedProxies` decides the bucket.** Without it, Better Auth trusts a single-value `x-forwarded-for` only, and every request carrying its own header shares one bucket. The list holds the private ranges that Railway's edge uses, which is the same list the web service's `Caddyfile` trusts. It is correct only while the API is reachable through that edge alone.

## GCP setup

`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are the same OAuth client used by the Gmail/Calendar integration flow at `/api/integrations/google/callback`. Better Auth derives its own callback URL: `${BETTER_AUTH_URL}/api/auth/callback/google`. Both URIs must be listed in the OAuth client's authorized redirect URIs in GCP Console. Calendar additionally requires the Google Calendar API to be enabled in the GCP project.

## GitHub setup

**GitHub App** (ADR-0052, migrated from the classic OAuth App 2026-06-08). Auth in `packages/integrations/src/github/app.ts`:

- **App JWT** — `jose` signs an RS256 token with `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`. GitHub issues a PKCS#1 key, so we use Node's `createPrivateKey` (jose's `importPKCS8` rejects PKCS#1).
- **Installation token** — `getInstallationToken(installationId)` (in `app.ts`) mints a ~1h token from the JWT; this is what GitHub REST tools use (`github.search`, `github.get_pull_request`, `github.get_issue`). Cached in-process. `getInstallationTokenForUser(userId)` (in `github/credentials.ts`) resolves the active credential's `installation_id` first.
- **User-to-server OAuth** — `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` identify the user during install (`exchangeUserCode`); stored as identity only. Connect builds the install URL (`buildInstallUrl`) from `GITHUB_APP_SLUG`; the App registered with `request_oauth_on_install` so install + authorize is one screen.
- **Callback** must be listed on the App: `${BETTER_AUTH_URL}/api/integrations/github/callback` (prod) and `http://localhost:3001/...` (local). The callback carries `code` + `installation_id` + `setup_action`; `installation_id` is persisted on `integration_credentials`.
- **Webhooks** — hook URL is the **prod server domain only** (`https://<server>/webhooks/github`); localhost can't receive deliveries. `verifyWebhookSignature` checks `X-Hub-Signature-256` (`GITHUB_WEBHOOK_SECRET`) over the raw body; deliveries land idempotently in `webhook_events`.

**Registering the App (one-time, manifest flow).** Easiest path — `POST` a manifest to `https://github.com/settings/apps/new` (App name must be globally unique; we used "Alfred 99Yash"), click "Create GitHub App", then exchange the returned one-time `code` at `POST https://api.github.com/app-manifests/{code}/conversions`. The conversion response carries everything: `id`, `slug`, `client_id`, `client_secret`, `webhook_secret`, and the `pem`. Set those as the seven `GITHUB_APP_*` / `GITHUB_WEBHOOK_SECRET` env vars locally (`apps/server/.env`) and on Railway (server service). Store the PEM with newlines escaped as `\n` on one line — callers un-escape via `.replace(/\\n/g, "\n")`.

The UI's "Connect" tile derives `status: "connected"` from the presence of an active GitHub `integration_credentials` row.
