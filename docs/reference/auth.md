# Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with Google as the sole social provider and the email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`. Google is the only sign-in method; there is no email/OTP path.

The allowlist rejects any signup whose email is not in `ALFRED_ALLOWED_EMAIL` — a comma-separated list parsed (in `packages/env`) into a normalized, lowercased array (a single email is still valid). It throws, which Better Auth converts to a 422. The hook runs for Google signups too — only an allowlisted Google account can sign in.

In Alfred route handlers, call `getSessionCached(request)` from `packages/http/src/middleware/session-cache.ts` to reuse the short request/token cache. Better Auth's mounted routes use their own session reader; the security policy does not depend on this cache.

## Session lifetime

`packages/auth/src/session-policy.ts` holds the `session` block that `auth()` takes (#454). Before it, Alfred set no block, so Better Auth's defaults applied and nothing recorded a decision. Three of the four numbers restate a default. The fourth is new.

| Number       | Value   | What it does                                                                |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `expiresIn`  | 7 days  | The idle window. Leave Alfred alone this long and the cookie dies.          |
| `updateAge`  | 1 day   | The slide step. Better Auth pushes `expires_at` forward at most this often. |
| `freshAge`   | 1 day   | How long after sign-in Better Auth still calls the session "fresh".         |
| absolute cap | 30 days | The hard ceiling, measured from sign-in. No amount of use extends it.       |

The slide makes the real idle window 6 to 7 days, not exactly 7. Better Auth rewrites `expires_at` to "now + 7 days" only when the row was last rewritten at least one day ago.

**The absolute cap is Alfred's own code, not a Better Auth option.** Better Auth slides `expires_at` forward for ever and offers no total bound. `authSessionPolicy()` owns the missing rule in `@alfred/auth`: its `databaseHooks.session.update.before` hook clamps each proposed slide to the earlier of the 7-day idle deadline and `session.created_at + 30 days`. Its path-independent `hooks.before` guard denies every request at or after the cap. Before the cap, the same guard normalizes a legacy row whose stored expiry exceeds the cap, so the endpoint's normal read returns a native `expires_at` that no downstream cache can extend. If that normalization fails, admission fails closed. For an over-age row, the guard attempts to delete only the row named by the verified token. Better Auth can skip that deletion if its pre-delete snapshot fails, so request admission does not depend on successful cleanup. Better Auth's normal persisted-expiry check then applies the stored deadline to Alfred routes and every mounted Better Auth route, including account-token routes. No route list or HTTP-owned age check is required. `session.created_at` is the origin, and no refresh path writes it — the slide touches `expires_at` and `updated_at` only.

The stronger boundary has two accepted costs. An authenticated Better Auth request performs one guard read before the endpoint's own session read. From about day 24 through day 30, Better Auth's update heuristic can also request another slide on each use because the clamped expiry no longer moves. That can produce one bounded session-row write per request during the final week. Alfred operates for one user, so these costs are acceptable.

**There is no freshness gate in front of Alfred's write tools, and that is a decision.** Better Auth measures `freshAge` from `session.created_at`, which no refresh moves, so a session can never become fresh again — only a new sign-in is fresh. Google is the sole sign-in path, so the gate could only ever be satisfied by a full OAuth round trip. Worse, the largest blast radius is the wrong side of the gate: briefings, triage, and every autonomous write run from the job queue with no session at all. The gate would add friction to chat and miss the background agent. Revisit it only together with a second sign-in path.

`freshAge` still controls Better Auth routes. In Better Auth 1.6.26, freshSessionMiddleware protects `/list-sessions` and `/unlink-account`. These routes refuse a session when its age from `session.created_at` reaches one day. `/delete-user` does not use this middleware; it has a separate age check that runs only for some request paths. `/revoke-sessions` and `/revoke-other-sessions` have no age check. Thus, the Settings control below works from a session of any age, and it shows no device count next to it.

### Sign out everywhere

Settings holds a "Sign out everywhere else" control (`apps/web/src/routes/-settings/user-section.tsx`). It calls Better Auth's `revokeOtherSessions()`, which attempts to delete every live session on the account except the caller's own.

The missing freshness check has two sides. A real user can recover from an old session without completing another Google sign-in. But a thief with a valid stolen cookie can also revoke every other session, sign the real user out elsewhere, and keep the stolen session active because the caller's session is the one row this operation preserves. The control and toast say "everywhere else" for this reason; they do not claim to end the caller's session.

The 10-second session cache (`packages/http/src/middleware/session-cache.ts`) would otherwise delay that revocation. The cache is keyed by token, and this control revokes tokens the request does not carry, so `invalidateSessionToken` cannot reach them. The root app therefore clears the whole cache after every successful `POST` below `/api/auth/`. This boundary rule also covers new or renamed Better Auth mutations without a route-list edit. Alfred has one user, so dropping the map costs one extra database read per live token. A positive cache entry is also bounded by the session row's own `expires_at`, so the cache cannot extend Better Auth's deadline.

Two limits remain. There is no cross-process invalidation, so another API process can continue to use its local cache after revocation. A settled entry normally expires within 10 seconds, but a read that is already in flight on that process can resolve after revocation and then populate its cache. That can extend the delay beyond the normal cache lifetime. `/sign-out` keeps its narrow pre-dispatch `invalidateSessionToken` call because it revokes the caller's own token, which the request carries; a successful response also gets the general post-dispatch clear.

### Cookie prefix

The session cookie carries the `__Secure-` name prefix in production: `__Secure-better-auth.session_token`. Better Auth adds it whenever secure cookies are on. `authCookiePolicy()` owns both `advanced.useSecureCookies` and `defaultCookieAttributes`, so the cookie name, `secure` attribute, and cross-site `sameSite` setting change together from the validated server environment. Production uses `None+Secure`; local development and tests use `Lax` without `secure` so HTTP localhost sign-in works.

`__Host-` is stronger and is not reachable. Better Auth never writes it, and its cookie reader looks for `__Secure-<name>` or the bare name only. A `__Host-` name forced through `advanced.cookies` would be a cookie Better Auth itself could no longer read.

## Rate limiting

`auth()` takes the `rateLimit` block from `packages/auth/src/rate-limit.ts` (#458). It is on in production only, and it counts in Redis rather than in the API process, so a restart or a second replica cannot reset the counter.

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
- **Webhooks** — the hook URL is the **prod server domain only** (`https://<server>/webhooks/inbound/github`; the App still points at the legacy alias `/webhooks/github`, which runs the same path). localhost can't receive deliveries. The `github` descriptor in `packages/assistant/src/connections/ingress/github.ts` calls `verifyWebhookSignature`, which checks `X-Hub-Signature-256` (`GITHUB_WEBHOOK_SECRET`) over the raw body before any parse. A verified delivery becomes one `event_receipts` row keyed by `X-GitHub-Delivery`, a queued `ingress.deliver` job publishes `github.<event>` on the trigger bus, and the `github-activity-fold` consumer writes the `webhook_events` row idempotently (ADR-0097).

**Registering the App (one-time, manifest flow).** Easiest path — `POST` a manifest to `https://github.com/settings/apps/new` (App name must be globally unique; we used "Alfred 99Yash"), click "Create GitHub App", then exchange the returned one-time `code` at `POST https://api.github.com/app-manifests/{code}/conversions`. The conversion response carries everything: `id`, `slug`, `client_id`, `client_secret`, `webhook_secret`, and the `pem`. Set those as the seven `GITHUB_APP_*` / `GITHUB_WEBHOOK_SECRET` env vars locally (`apps/server/.env`) and on Railway (server service). Store the PEM with newlines escaped as `\n` on one line — callers un-escape via `.replace(/\\n/g, "\n")`.

The UI's "Connect" tile derives `status: "connected"` from the presence of an active GitHub `integration_credentials` row.
