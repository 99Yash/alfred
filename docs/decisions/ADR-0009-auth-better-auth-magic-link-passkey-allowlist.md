# ADR-0009 — Auth: Better Auth + magic link + passkey + allowlist


**Decision.** Better Auth with both email-magic-link and passkey enabled. A signup hook enforces a one-email allowlist (env var). Same shape as `@milkpod/auth`.

**Why.**

- Direct copy from milkpod scaffolding — fastest path to a working auth surface.
- Passkeys give one-tap login on every registered device.
- Magic-link / OTP is the recovery path if a passkey is lost.
- Allowlist is a one-line guard, removable in one commit when graduating to multi-user.
- Better Auth gives us the user session that integration OAuth callbacks attach to. Integration tokens (Gmail/Slack/etc) are stored in their own per-user `integration_credentials` table — separate from auth.

**Implementation note (2026-04-27).** Milestone-1 scaffolding shipped with **emailOTP only**, not passkey. better-auth@1.6.9 (latest within milkpod's catalog `^1.3.28` range) does not export `./plugins/passkey` from its package — the plugin appears to have been removed from the main package mid-reorganization, with no clear replacement yet (no `@better-auth/passkey` peer package on the registry as of writing). Passkey is **deferred** until either (a) better-auth's plugin layout stabilizes and exposes passkey again, or (b) we wire `@simplewebauthn/server` directly. emailOTP satisfies the "real auth flow, not bearer token" intent of this ADR for v1.

**Correction (2026-07-30).** The note above is wrong about what shipped: **emailOTP never landed in this repo.** `packages/auth/src/index.ts` configures no better-auth plugins at all, and `git log -S emailOTP -- packages/auth` is empty. The only sign-in path Alfred has ever had is **Google social**, with the allowlist enforced in the `user.create.before` hook. `apps/web/src/routes/-login/auth-panel.tsx` renders one button to match.

So the ADR's decision — magic link plus passkey — is entirely **unbuilt**, not partly built. Both remain the intended recovery story; neither has an issue or a date. Two consequences worth stating, because they are what the gap actually costs:

- **There is no recovery path today.** If the Google grant is lost, there is no second way in. At a one-user allowlist that is an acceptable risk, not an oversight — but it is a real one, and it is the reason this ADR should not be closed.
- **`account.accountLinking.disableImplicitLinking` was considered and rejected** while closing CVE-2026-53516 (#455). With one provider it can never fire, and if magic link later ships first for a given user it would refuse the subsequent Google link with no in-app escape. The version floor (`^1.6.11`, which defaults `requireLocalEmailVerified` to true) is what closes the CVE. Revisit the flag when a second provider and a `linkSocial()` control land together.

**Alternatives.**

- Passkey-only (rejected — no recovery path).
- Env-based bearer token (rejected — weak resume signal, no graduation story, doesn't compose with OAuth integration callbacks).
- Edge auth via Cloudflare Access / Tailscale Funnel (rejected — doesn't compose with external OAuth callbacks).
