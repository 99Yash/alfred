# Briefing

> **Status (2026-06-02).** This describes the **target** model (ADR-0048), which replaces the current `morning-briefing` workflow (the m10 deterministic inbox digest — composed prose over triage tags, sent unconditionally every morning). The current build is being torn out and rebuilt against this spec, not patched. The gather/compose/reference/`briefings`-entity machinery from ADR-0041 survives; the firing model, surface split, and framing change.

## The unit: open loops

The thing Alfred tracks is the **open loop** — anything across the connected integrations (email, calendar, GitHub, Slack, …) that needs the user or shapes their day. Briefings are not a feature that *summarizes inputs*; they are **renders of the open-loops model** at a moment in time:

- the **inbox** is the "now" render,
- the **morning briefing** is the render at the start of the day,
- the **evening briefing** is the render at its close.

Two consequences fall out of this framing:

- **Triage labels are immutable.** A thread tagged `action_needed` stays that way — it was correct when written. Briefings do **read-only reconciliation at compose time**: if a PR merged on GitHub (silently, no email), the loop closed, so the briefing doesn't surface it — but it never rewrites the triage record. Thread-cache invalidation on *new Gmail activity* is a separate, existing concern, not this workflow's job.
- **No cross-source state machine yet.** Reconciliation happens at compose time, not continuously. Webhook-driven live reconciliation (so the inbox is also correct between briefings) is the right end-state but is explicitly deferred (see [Parked](#parked)).

**Source-availability contract (closure requires positive evidence).** Reconciliation is fail-safe toward surfacing. A loop is treated as closed **only** on a *positive authoritative signal* (GitHub reports the PR merged; a Gmail thread shows a reply was sent). When the provider is unavailable — scope missing, integration not connected, API error, or a `null` contribution — the loop **stays live and is surfaced**, optionally flagged "couldn't verify current state." The composer is **forbidden from inferring closure**: gather computes loop status, the composer only renders it. Email signals may *open or sustain* a loop and may carry positive progress evidence, but their **absence never closes** one. (ADR-0048 decision D.)

## Form

A **small paragraph, under 6 sentences.** Not a list, not a digest. Still-live / urgent items collapse to **one summary sentence**, and that sentence is **omitted entirely when nothing is live** — no padding, no "you have no urgent items today." The email stays short and ends with a **`View full briefing`** link into the in-app detail surface.

## Two surfaces, two firing models

Morning and evening run on **deliberately different** firing models. This asymmetry is the point, not an inconsistency.

### Morning — orientation (discretionary)

- **Job:** what does my day look like before I start it. Forward-facing.
- **Window:** today + tomorrow.
- **Inputs:** calendar-anchored, folding in **recall** (a commitment or context from email/any integration, surfaced *because* it connects to something concrete on today/tomorrow's calendar — never free-floating) and **still-live** action items (reconciled, one sentence).
- **Firing:** **discretionary.** A routine day with nothing to orient → **silent, no email.** But the judgment **errs toward sending** on ambiguity: the costs are asymmetric — an unnecessary 6-sentence email costs ten seconds, a wrongly-suppressed briefing costs the thing you missed (the dropped ball). Silence is the expensive error, so it's reserved for genuinely-nothing days.
- **Mechanics:** compose-then-gate. Alfred drafts the paragraph, then decides whether it clears the bar. A suppressed morning is a **persisted terminal state** (`status='suppressed'`, `send_decision='suppressed'`, `gate_reason` recorded, `email_send_id=NULL`) — the composed body is still stored, so **nothing emails out** but the in-app surface renders the quiet record ("quiet day, nothing urgent") from a real row, never a faked empty-state. Suppression is morning-only; evening always sends. (ADR-0048 decision C.)
- **Timing:** one shot, early, before the day starts. Nothing hourly, no re-pings.

### Evening — close (always fires)

- **Job:** close the day.
- **Content:** synthesis of what came in (loops that **closed** / still **open** — closure, *not* a transcript of what the user watched happen all day) + any **meeting still left this evening** + optional **tomorrow-prep** (surfaced at night so the user can act while there's still time) + a **human leaving note**.
- **Firing:** **always fires** — closure is its job, and there's always something true to say. Content **degrades gracefully**: real substance when there is some, down to **weather + a personal sign-off** when there isn't (*"34°C in Delhi, clear sky. See you tomorrow, Yash."*). The weather changes daily, so the sign-off never decays into wallpaper.
- **Week note:** a week-level note ("brutal week — actually log off") rides along *occasionally*, keyed to real week intensity, not nightly.

## Day-aware framing, localized

Both surfaces read the **kind of day** before choosing their words: weekday vs weekend vs *the user's* holidays. Holidays are **localized via the onboarding profile** (region/locale) — Thanksgiving means nothing in India. A Sunday still surfaces a genuinely-live urgent item, but **rephrased for downtime** ("nothing needs you today, but X landed if you want it") rather than narrated like a workday. Same facts, different voice.

## Channel

Email is the **push**; the in-app briefing is the **durable home** — a history to scroll back through, plus the silent-day escape hatch above. Email carries the tight paragraph + `View full briefing` link; the in-app surface is the canonical record. (ADR-0020: email-only at v1; in-app surface is Replicache-synced, read-only.)

## Parked

Explicit non-goals for this iteration — each merits its own discussion:

- **Advance reminders** — commitments with a future date-of-impact, surfaced N days out, off-cadence (not tied to the morning/evening slots). A separate workflow.
- **Anomaly detection** — "you agreed to a meeting that isn't on the calendar yet." Highest magic, highest annoyance risk (a wrong nag burns trust fast) — deliberately deferred.
- **Continuous open-loops state machine** — webhook-driven reconciliation so the *inbox* is also correct between briefings, not just at compose time. The right end-state; today is compose-time reconciliation only.

## OAuth scopes

> **Changed from m10.** The m10 briefing read Gmail-only from the local DB and skipped `requireScopes`. The target model adds **calendar anchoring** and **compose-time reconciliation**, so briefing is no longer local-DB-only: **`CALENDAR_READONLY_SCOPE` (`calendar.readonly`, `oauth.ts`)** lives in `GOOGLE_FEATURE_SCOPES.briefing` for read-only gather. Interactive Calendar connects now grant `calendar.events` for read/write tools, and read paths accept either scope so older readonly credentials continue working. Existing users re-consent on next refresh/reconnect; `include_granted_scopes=true` merges it into the existing grant. Reconciliation reads ingested integration state where Alfred has it. Per the source-availability contract above, missing scope or unavailable provider state **degrades to surface-as-live**, never to inferred closure.

- `packages/integrations/src/google/oauth.ts` exposes `GOOGLE_FEATURE_SCOPES` (`briefing` / `triage` / `reply_draft`) + `scopesForFeatures(features?)`. Scopes are tiered into `PUBLIC_FEATURES` (free-to-verify: calendar, Workspace reads, `gmail.send`) and `RESTRICTED_FEATURES` (`briefing` / `triage` / `drive` — needs the paid CASA assessment to go public). `PUBLIC_GOOGLE_SCOPES` is the public-only union; `ALL_GOOGLE_SCOPES` is every feature. `DEFAULT_GOOGLE_SCOPES` aliases `PUBLIC_GOOGLE_SCOPES` (deprecated; prefer the explicit names).
- `/api/integrations/google/connect` defaults (no param) to the **public** scope set. Restricted Gmail/Drive features are explicit opt-in: `?features=briefing,triage`. A malformed/empty `features` param falls back to the public set rather than escalating.
- `requireScopes(credentialId, features[])` from `@alfred/integrations/google` throws `MissingScopesError` (`code: 'MISSING_SCOPES'`) when a credential drifted; workflows that hit Gmail directly should call this.
