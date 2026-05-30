# Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with Google as the sole social provider and the email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`. Google is the only sign-in method; there is no email/OTP path.

The allowlist rejects any signup whose email is not in `ALFRED_ALLOWED_EMAIL` — a comma-separated list parsed (in `packages/env`) into a normalized, lowercased array (a single email is still valid). It throws, which Better Auth converts to a 422. The hook runs for Google signups too — only an allowlisted Google account can sign in.

`packages/auth/src/session.ts` exports `sessionAuth()` — a lightweight instance for session-only verification (no social providers, no plugins). Used by `session-cache.ts`.

In route handlers, call `getSessionCached(request)` from `packages/api/src/middleware/session-cache.ts` — never `auth().api.getSession()` directly.

## GCP setup

`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are the same OAuth client used by the Gmail/Calendar integration flow at `/api/integrations/google/callback`. Better Auth derives its own callback URL: `${BETTER_AUTH_URL}/api/auth/callback/google`. Both URIs must be listed in the OAuth client's authorized redirect URIs in GCP Console. Calendar additionally requires the Google Calendar API to be enabled in the GCP project.

## GitHub setup

Classic OAuth App (not GitHub App). `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` are read by `packages/integrations/src/github/oauth.ts`. Authorization callback URL on the OAuth App must be `${BETTER_AUTH_URL}/api/integrations/github/callback`. Classic tokens don't rotate — `getGithubAccessToken` returns the stored token directly. The UI's "Connect" tile derives `status: "connected"` from the presence of an active `integration_credentials` row with `read:user` granted.
