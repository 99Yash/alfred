# Morning briefing (m10)

Per ADR-0025 #2 alfred sends a daily inbox-only digest email built from triage tags. Calendar + "relevant updates" sections are deferred to a follow-up milestone.

The pipeline:

1. `briefing.tick` (BullMQ cron, hourly) scans users; for each, resolves `briefing.timezone` + `briefing.delivery_hour` from `user_preferences` (fallback chain: pref row → `UTC` + `7`) and enqueues a `morning-briefing` agent run when the user's local hour matches.
2. The `morning-briefing` workflow (`apps/server/src/builtins/workflows/morning-briefing.ts`) runs `gather` → `compose` → `send`:
   - `gather` queries `email_triage` joined to `documents` for the last 24h, partitioning into `action_needed` / `awaiting_reply` / `meeting` / `payment` priority buckets and counting `newsletter` / `fyi` for the suppressed-counts tail line.
   - `compose` renders a deterministic HTML+text email (no LLM call — the classifier rationales already carry the per-item gloss).
   - `send` calls `notify()` with idempotency key `briefing:{userId}:{YYYY-MM-DD-in-user-tz}`.
3. `notify()` (`packages/api/src/modules/notifications/`) writes an `email_sends` row at `status='queued'`, POSTs to Resend, then transitions to `'sent'` (with provider id) or `'failed'`. The `(user_id, idempotency_key)` unique index is what makes a duplicate cron tick a no-op.

OAuth scope refactor that landed alongside m10:

- `packages/integrations/src/google/oauth.ts` exposes `GOOGLE_FEATURE_SCOPES` (`briefing` / `triage` / `reply_draft`) + `scopesForFeatures(features?)`. Scopes are tiered into `PUBLIC_FEATURES` (free-to-verify: calendar, Workspace reads, `gmail.send`) and `RESTRICTED_FEATURES` (`briefing` / `triage` / `drive` — needs the paid CASA assessment to go public). `PUBLIC_GOOGLE_SCOPES` is the public-only union; `ALL_GOOGLE_SCOPES` is every feature. `DEFAULT_GOOGLE_SCOPES` now aliases `PUBLIC_GOOGLE_SCOPES` (deprecated; prefer the explicit names).
- `/api/integrations/google/connect` defaults (no param) to the **public** scope set — no restricted scopes, no unverified-app warning. Restricted Gmail/Drive features are explicit opt-in: `?features=briefing,triage`. A malformed/empty `features` param falls back to the public set rather than escalating.
- `requireScopes(credentialId, features[])` from `@alfred/integrations/google` throws `MissingScopesError` (typed `code: 'MISSING_SCOPES'`) when a credential drifted; workflows that hit Gmail directly should call this. Briefing reads from local DB only and skips it.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-briefing.ts` (forces a send for the first user, ignoring the tz/hour gate; verifies idempotent re-run).
