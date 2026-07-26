# ADR-0009 — Auth: Better Auth + magic link + passkey + allowlist


**Decision.** Better Auth with both email-magic-link and passkey enabled. A signup hook enforces a one-email allowlist (env var). Same shape as `@milkpod/auth`.

**Why.**

- Direct copy from milkpod scaffolding — fastest path to a working auth surface.
- Passkeys give one-tap login on every registered device.
- Magic-link / OTP is the recovery path if a passkey is lost.
- Allowlist is a one-line guard, removable in one commit when graduating to multi-user.
- Better Auth gives us the user session that integration OAuth callbacks attach to. Integration tokens (Gmail/Slack/etc) are stored in their own per-user `integration_credentials` table — separate from auth.

**Implementation note (2026-04-27).** Milestone-1 scaffolding shipped with **emailOTP only**, not passkey. better-auth@1.6.9 (latest within milkpod's catalog `^1.3.28` range) does not export `./plugins/passkey` from its package — the plugin appears to have been removed from the main package mid-reorganization, with no clear replacement yet (no `@better-auth/passkey` peer package on the registry as of writing). Passkey is **deferred** until either (a) better-auth's plugin layout stabilizes and exposes passkey again, or (b) we wire `@simplewebauthn/server` directly. emailOTP satisfies the "real auth flow, not bearer token" intent of this ADR for v1.

**Alternatives.**

- Passkey-only (rejected — no recovery path).
- Env-based bearer token (rejected — weak resume signal, no graduation story, doesn't compose with OAuth integration callbacks).
- Edge auth via Cloudflare Access / Tailscale Funnel (rejected — doesn't compose with external OAuth callbacks).
