# Briefing

> **Status (2026-07-10).** `daily-briefing` is the canonical live workflow for both morning and evening slots. A legacy compatibility adapter can resume nonterminal runs persisted before the cutover, but it cannot start new runs and is not scheduled, catalogued, or seeded. The legacy `briefing_runs` table remains in the schema to avoid a destructive migration, while live writes use the canonical `briefings` entity.

## The unit: open loops

The thing Alfred tracks is the **open loop** — anything across the connected integrations (email, calendar, GitHub, Slack, …) that needs the user or shapes their day. Briefings are not a feature that _summarizes inputs_; they are **renders of the open-loops model** at a moment in time:

- the **inbox** is the "now" render,
- the **morning slot** is the render at the start of the day,
- the **evening slot** is the render at its close.

Two consequences fall out of this framing:

- **Triage labels are immutable.** A thread tagged `action_needed` stays that way — it was correct when written. Briefings do **read-only reconciliation at compose time**: if a PR merged on GitHub (silently, no email), the loop closed, so the briefing doesn't surface it — but it never rewrites the triage record. Thread-cache invalidation on _new Gmail activity_ is a separate, existing concern, not this workflow's job.
- **No cross-source state machine yet.** Reconciliation happens at compose time, not continuously. Webhook-driven live reconciliation (so the inbox is also correct between briefings) is the right end-state but is explicitly deferred (see [Parked](#parked)).

**Source-availability contract (closure requires positive evidence).** Reconciliation is fail-safe toward surfacing. A loop is treated as closed **only** on a _positive authoritative signal_ (GitHub reports the PR merged; a Gmail thread shows a reply was sent). When the provider is unavailable — scope missing, integration not connected, API error, or a `null` contribution — the loop **stays live and is surfaced**, optionally flagged "couldn't verify current state." The composer is **forbidden from inferring closure**: gather computes loop status, the composer only renders it. Email signals may _open or sustain_ a loop and may carry positive progress evidence, but their **absence never closes** one. (ADR-0048 decision D.)

## Form

A **small paragraph, under 6 sentences.** Not a list, not a digest. Still-live / urgent items collapse to **one summary sentence**, and that sentence is **omitted entirely when nothing is live** — no padding, no "you have no urgent items today." The email stays short and ends with a **`View full briefing`** link into the in-app detail surface.

## Two surfaces, two firing models

Morning and evening run on **deliberately different** firing models. This asymmetry is the point, not an inconsistency.

### Morning — orientation (discretionary)

- **Job:** what does my day look like before I start it. Forward-facing.
- **Window:** today + tomorrow.
- **Inputs:** calendar-anchored, folding in **recall** (a commitment or context from email/any integration, surfaced _because_ it connects to something concrete on today/tomorrow's calendar — never free-floating) and **still-live** action items (reconciled, one sentence).
- **Firing:** **discretionary.** A routine day with nothing to orient → **silent, no email.** But the judgment **errs toward sending** on ambiguity: the costs are asymmetric — an unnecessary 6-sentence email costs ten seconds, a wrongly-suppressed briefing costs the thing you missed (the dropped ball). Silence is the expensive error, so it's reserved for genuinely-nothing days.
- **Mechanics:** compose-then-gate. Alfred drafts the paragraph, then decides whether it clears the bar. A suppressed morning is a **persisted terminal state** (`status='suppressed'`, `send_decision='suppressed'`, `gate_reason` recorded, `email_send_id=NULL`) — the composed body is still stored, so **nothing emails out** but the in-app surface renders the quiet record ("quiet day, nothing urgent") from a real row, never a faked empty-state. Suppression is morning-only; evening always sends. (ADR-0048 decision C.)
- **Timing:** one shot, early, before the day starts. Nothing hourly, no re-pings.

### Evening — close (always fires)

- **Job:** close the day.
- **Content:** synthesis of what came in (loops that **closed** / still **open** — closure, _not_ a transcript of what the user watched happen all day) + any **meeting still left this evening** + optional **tomorrow-prep** (surfaced at night so the user can act while there's still time) + a **human leaving note**.
- **Firing:** **always fires** — closure is its job, and there's always something true to say. Content **degrades gracefully**: real substance when there is some, down to **weather + a personal sign-off** when there isn't (_"34°C in Delhi, clear sky. See you tomorrow, Yash."_). The weather changes daily, so the sign-off never decays into wallpaper.
- **Week note:** a week-level note ("brutal week — actually log off") rides along _occasionally_, keyed to real week intensity, not nightly.

## Day-aware framing, localized

Both surfaces read the **kind of day** before choosing their words: weekday vs weekend vs _the user's_ holidays. Holidays are **localized via the onboarding profile** (region/locale) — Thanksgiving means nothing in India. A Sunday still surfaces a genuinely-live urgent item, but **rephrased for downtime** ("nothing needs you today, but X landed if you want it") rather than narrated like a workday. Same facts, different voice.

## Channel

Email is the **push**; the in-app briefing is the **durable home** — a history to scroll back through, plus the silent-day escape hatch above. Email carries the tight paragraph + `View full briefing` link; the in-app surface is the canonical record. (ADR-0020: email-only at v1; in-app surface is Replicache-synced, read-only.)

## Context signals and the memory write policy

> **Added ADR-0083 (#415).** Contract lives in `@alfred/contracts/briefing-signals.ts`.

Everything a briefing writer says flows through **three layers**, and the contract owns the boundary between them:

1. **Source evidence** — the raw gather items (a Gmail thread, a calendar event, a GitHub activity row), each addressable by a `BriefingReference` token, validated at its owning boundary, never authored by a model.
2. **Typed context signals** — the generic `BRIEFING_CONTEXT_SIGNAL_KINDS` vocabulary (`development`, `open_loop`, `pattern`, `constraint`). Domain meaning lives in a required bounded `summary`, so a moved interview and a merged PR can both be developments without becoming permanent enum members. Signals are derived deterministically or by a bounded projection from Layer 1 and carry their evidence back to it. `briefingContextSignalSchema` requires **non-empty** evidence ("no grounding, no row").
3. **Generated prose** — the warm paragraph the writer emits. It consumes Layer 2, invents no durable facts, and is deliberately not a type: prose is ephemeral by construction.

All context signals are query-time views and must **never** be persisted as memory. Durable truth belongs in its owning domain or projection and may be cited as evidence; a presentation-layer signal kind does not decide durability.

**Memory write policy.** Briefing signals are a namespace disjoint from the complete `user_facts.key` gate. Briefing work must not promote email/document metadata (subject, sender, message-id, dates), a third party's attributes, or a contextual interpretation into the user's identity/org facts. This is the `yash.k@oliv.ai` / `employer="Weekday"` failure mode (`.lessons/user-facts-document-metadata-noise.md`). Durable identity/org writes stay the job of the ADR-0080 projection (`PROJECTION_IDENTITY_KEYS`); enforcement lives in `fact-policy.ts` (ADR-0079) and the projection (ADR-0080). This module names the policy and pins the disjoint-namespace invariant in tests; it does not re-implement the gate.

## Parked

Explicit non-goals for this iteration — each merits its own discussion:

- **Advance reminders** — commitments with a future date-of-impact, surfaced N days out, off-cadence (not tied to the morning/evening slots). A separate workflow.
- **Anomaly detection** — "you agreed to a meeting that isn't on the calendar yet." Highest magic, highest annoyance risk (a wrong nag burns trust fast) — deliberately deferred.
- **Continuous open-loops state machine** — webhook-driven reconciliation so the _inbox_ is also correct between briefings, not just at compose time. The right end-state; today is compose-time reconciliation only.

## OAuth scopes

> **Changed from m10.** The m10 briefing read Gmail-only from the local DB and skipped `requireScopes`. The live model adds **calendar anchoring** and **compose-time reconciliation**, so briefing is no longer local-DB-only: **`CALENDAR_READONLY_SCOPE` (`calendar.readonly`, `oauth.ts`)** lives in `GOOGLE_FEATURE_SCOPES.briefing` for read-only gather. Interactive Calendar connects now grant `calendar.events` for read/write tools, and read paths accept either scope so older readonly credentials continue working. Existing users re-consent on next refresh/reconnect; `include_granted_scopes=true` merges it into the existing grant. Reconciliation reads ingested integration state where Alfred has it. Per the source-availability contract above, missing scope or unavailable provider state **degrades to surface-as-live**, never to inferred closure.

- `packages/integrations/src/google/oauth.ts` exposes `GOOGLE_FEATURE_SCOPES` (`briefing` / `triage` / `reply_draft`) + `scopesForFeatures(features?)`. `ALL_GOOGLE_SCOPES` is the union of every feature; `DEFAULT_GOOGLE_SCOPES` aliases it. The old PUBLIC/RESTRICTED scope tiering was removed when ADR-0044 was amended (2026-06-08) to grant-all — Alfred runs single Production-unverified, so there is no public-app verification surface to minimize.
- `/api/integrations/google/connect` defaults (no param) to the **full** grant — every feature in one consent. `?features=briefing,triage` narrows the request for a targeted reconnect; a malformed/empty `features` param requests identity scopes only (it does not widen to the full grant).
- `requireScopes(credentialId, features[])` from `@alfred/integrations/google` throws `MissingScopesError` (`code: 'MISSING_SCOPES'`) when a credential drifted; workflows that hit Gmail directly should call this.
