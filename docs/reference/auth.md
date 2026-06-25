# Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with Google as the sole social provider and the email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`. Google is the only sign-in method; there is no email/OTP path.

The allowlist rejects any signup whose email is not in `ALFRED_ALLOWED_EMAIL` — a comma-separated list parsed (in `packages/env`) into a normalized, lowercased array (a single email is still valid). It throws, which Better Auth converts to a 422. The hook runs for Google signups too — only an allowlisted Google account can sign in.

`packages/auth/src/session.ts` exports `sessionAuth()` — a lightweight instance for session-only verification (no social providers, no plugins). Used by `session-cache.ts`.

In route handlers, call `getSessionCached(request)` from `packages/api/src/middleware/session-cache.ts` — never `auth().api.getSession()` directly.

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
