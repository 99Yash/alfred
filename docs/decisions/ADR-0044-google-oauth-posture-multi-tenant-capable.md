# ADR-0044 — Google OAuth posture: multi-tenant-capable architecture, Production-unverified single-tenant operation, least-privilege scope tiers

**Decision.** Alfred is **architected multi-tenant** (per-user `integration_credentials`, per-user `user_action_policies`, `user_id` partitioning throughout) but **operated as a single tenant** today. The Google OAuth consent screen moves from **Testing → Production publishing status, deliberately unverified**. Scopes are requested **least-privilege, tracking the registered tool set**; we extend freely into **sensitive** scopes (app verification, no security assessment) and take exactly **one restricted** scope as a knowing concession (`gmail.modify` — reading and labeling mail is the product). The granted set is the union of scopes required by _currently registered_ tools; adding a scope is an incremental re-consent, after which the refresh token is no longer subject to Testing mode's 7-day expiry (it is still revocable and subject to Google's normal token limits).

**Why this is its own ADR.** ADR-0001 fixed single-user scope. This ADR records that single-user is the current _operating mode_, not an _architectural ceiling_ — and reasons through the OAuth verification economics that make "go public someday" a submission + auth-policy flip rather than a rewrite. A future reader will ask "why is the production app intentionally unverified, and why these specific scopes?"; this answers both.

**The verification economics (the load-bearing facts).**

- **Testing publishing status** (where we were): users must be listed as test users, non-profile authorizations expire after 7 days, and there is a 100-test-user cap. The 7-day refresh-token expiry is the operational pain on an always-on assistant.
- **Production, unverified:** anyone can attempt consent, the unverified-app warning appears for unapproved sensitive/restricted scopes, and a 100-new-user cap applies while the app remains unverified. At single-tenant scale every downside is a non-issue; the win is avoiding Testing mode's 7-day token expiry. **We never submit for verification, so there is nothing to be rejected** — the historical "Google would never approve it" wall exists only on the _verified-public_ path.
- **Google scope tiers** set the bar to ever go public:
  - **Non-sensitive** (`drive.file`, `openid`, `email`): no sensitive/restricted scope review; a public branded app can still need basic app/brand verification, but this is not the expensive path.
  - **Sensitive** (`gmail.send`, `calendar.events`, `documents`, `spreadsheets`, `presentations`): app verification — privacy policy, demo video, logo, justification. No security assessment.
  - **Restricted** (`gmail.readonly`, `gmail.modify`, full `drive`): restricted verification **plus a security assessment if restricted-scope data is stored or transmitted through servers**. This is the real public wall for a solo dev.

**Scope set (least-privilege, tracks tools).**

| Surface                                | Scope                                        | Tier                                | Why                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                               | `openid`, `userinfo.email`                   | profile-only                        | sign-in / credential row identity                                                                                                                                                                                                        |
| Drive (create)                         | `drive.file`                                 | non-sensitive                       | create/edit Alfred-owned docs/sheets/slides (the "make me a PPT" path); also gains per-file access to files the user picks via Google Picker — no restricted scope needed                                                                |
| Gmail send                             | `gmail.send`                                 | sensitive                           | send / reply                                                                                                                                                                                                                             |
| Calendar                               | `calendar.events`                            | sensitive                           | read + create/update/delete events (narrower than full `calendar`)                                                                                                                                                                       |
| Workspace edit _(optional power tier)_ | `documents`, `spreadsheets`, `presentations` | sensitive                           | edit _existing_ Workspace files the user already has. Default **off** in favor of `drive.file` + Picker; enable when a tool genuinely needs cross-file edit. Listed because they do not trigger the restricted-scope security assessment |
| Gmail read + label                     | `gmail.modify`                               | **restricted (the one concession)** | read message bodies, apply/remove labels (triage, briefing, search). `gmail.readonly` is subsumed                                                                                                                                        |

**Explicitly NOT requested:** `https://mail.google.com/` (full IMAP/delete), `gmail.settings.*`, full `drive` / `drive.readonly`, Admin SDK, Contacts, Tasks — none map to a current tool, and each widens breach radius and verification surface.

**Consequences for "go public."** The public path is: verify the sensitive scopes + commit to the security assessment for the `gmail.modify` family (the single restricted scope, because Alfred stores/transmits Gmail data server-side) + remove ADR-0009's one-email allowlist for open signup. Keeping the restricted surface to **one** scope family is deliberate — it makes the eventual restricted-scope review as small as Google allows. Multi-tenant architecture means none of this is a rewrite.

**Resume framing.** The defensible artifact is the _documented trade-off_, not a paid audit: "architected multi-tenant, operated single-tenant Production-unverified to avoid a restricted-scope security assessment disproportionate for a portfolio project; least-privilege scopes keep the verification surface minimal; going public is a verification submission + allowlist removal."

**Operational steps (no code).** Flip the GCP consent screen Testing → Production; re-consent the owner account once under the broadened scopes to get a refresh token outside Testing mode's 7-day expiry; record the "to go public" checklist alongside this ADR.

**Source check (2026-05-27).** Verified against Google's OAuth, Drive, Gmail, Calendar, Sheets, and Slides docs: Testing-mode offline grants expire after 7 days for non-profile scopes; In Production unverified apps show the warning and have a 100-new-user cap; `drive.file` is non-sensitive and per-file; Gmail `gmail.send` is sensitive while `gmail.readonly`/`gmail.modify` are restricted; restricted scopes require a security assessment when restricted data is stored or transmitted through servers. Key refs: [OAuth token expiry](https://developers.google.com/identity/protocols/oauth2), [app audience/user cap](https://support.google.com/cloud/answer/15549945), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [restricted scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Alternatives.**

- (a) **Stay in Testing mode.** Rejected — the 7-day refresh-token expiry on an always-on assistant is a recurring outage; Production-unverified fixes it for free.
- (b) **Pursue verification + security assessment now.** Rejected — recurring paid audit, disproportionate for current scope; nothing forces it at single-tenant.
- (c) **Broad "grant-all" restricted scopes (full `drive`, full mailbox).** Rejected (reversed an earlier inclination, 2026-05-27) — maximizes breach radius and verification surface and directly fights the public-someday goal; the capability gained is "edit files the user never opened with Alfred," exactly what a public app couldn't keep.
- (d) **`drive.file` only, no sensitive scopes.** Rejected — too narrow; can't send mail or manage calendar, which the assistant needs. Sensitive scopes cost only brand verification, so we take them.

**Open.**

- Whether to enable the `documents`/`spreadsheets`/`presentations` power tier or stay on `drive.file` + Picker — decide when a cross-file-edit tool is actually built.
- Exact "go public" checklist contents (capture alongside this ADR when the flip is scheduled).
- **Self-host-per-user as a third path:** Alfred could ship as a self-hosted instance where each user runs their own GCP project + Production-unverified consent screen. Then _every user is their own OAuth developer account_, and the restricted-scope security assessment does not apply to a centralized public app because there is no centralized public OAuth client. Strong candidate; revisit if/when distribution becomes real.

**Cross-ref.** Records the operating mode under ADR-0001; supplies the OAuth grants ADR-0043's write tools call; the eventual public flip touches ADR-0009 (auth allowlist).

**Amendment (2026-06-08) — never public → grant-all in one consent; reverses alt-(c).**

The load-bearing assumption of the original decision — "go public someday" — is retired. Alfred is now explicitly a **single-tenant, Production-unverified app forever**. That collapses the entire verification calculus: an unverified Production app can request _any_ scope, restricted included, with **no CASA, no security assessment, no review** — the sole owner clicks through the one-time "unverified app" warning and grants the lot. The 100-new-user cap and the unverified warning are non-issues at single-tenant scale; the 7-day Testing-mode token expiry is already gone (we are in Production). There is **nothing to verify and nothing to be rejected**, so least-privilege buys _nothing_ operationally — it bought only a smaller eventual verification surface, and that goal no longer exists.

Therefore:

- **Onboarding requests the full grant in one consent** (no per-feature opt-in step). `/api/integrations/google/connect` with no `?features` param resolves to `ALL_GOOGLE_SCOPES`. The `?features=` param survives for _targeted reconnects_ only.
- **This reverses alt-(c)** ("broad grant-all restricted scopes"), rejected 2026-05-27 _expressly because of the public-someday goal_. With that goal gone, alt-(c)'s sole objection ("exactly what a public app couldn't keep") no longer applies.
- **The PUBLIC/RESTRICTED scope-tier apparatus is deleted** from `oauth.ts` (`PUBLIC_FEATURES`, `RESTRICTED_FEATURES`, `PUBLIC_GOOGLE_SCOPES`, `RESTRICTED_SCOPES`, `isRestrictedFeature`, the module-load guardrail). `GOOGLE_FEATURE_SCOPES` + `scopesForFeatures()` + `requireScopes()` stay — per-feature resolution still drives targeted reconnects and per-tool capability gating.

**Amended scope set.**

| Surface                | Scope                                                     | Tier (informational only now)                                |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| Identity               | `openid`, `userinfo.email`                                | profile                                                      |
| Gmail                  | `gmail.modify` + `gmail.send`                             | restricted + sensitive                                       |
| Calendar               | `calendar.events` (+ `calendar.readonly` via `briefing`)  | sensitive                                                    |
| Drive                  | `https://www.googleapis.com/auth/drive` (full r/w)        | restricted — **upgraded from `drive.file`/`drive.readonly`** |
| Docs / Sheets / Slides | `documents` / `spreadsheets` / `presentations` (full r/w) | sensitive                                                    |

**Still deliberately omitted:** `https://mail.google.com/` (full IMAP + permanent delete) — no tool needs it and it maximizes breach radius. Flip it only if a delete-mail tool is ever built.

**Resume framing (revised).** The original framing leaned on least-privilege + "public is a submission flip." The now-true narrative: _single-user personal assistant where the owner is the only principal — least-privilege across one's own data buys nothing, so I optimized for capability and documented the reversal in this ADR._ This is the open-item (d) below ("self-host-per-user / owner-is-developer") made concrete: in a single-owner deployment the OAuth developer **is** the data subject, which is exactly why no centralized verification regime applies.

**Operational steps (manual, owner).** In the GCP console add `gmail.modify`, full `drive`, and `documents` to the OAuth consent screen scope list (GCP will warn "requires verification" — save anyway; unverified-under-cap usage is unaffected). Confirm publishing status remains **In production**. Re-consent the owner account once to pick up the broadened grant.

**What's unchanged.** Multi-tenant _architecture_ (per-user `integration_credentials`, `user_id` partitioning) stays — it costs nothing and keeps "go public" a non-rewrite if the never-public stance ever reverses. Production-unverified posture stays. The write _surface_ is still gated by ADR-0043 (registry + `allowed_integrations` + action policy); broadening the OAuth grant unblocks write tools but does not register or auto-authorize any.
