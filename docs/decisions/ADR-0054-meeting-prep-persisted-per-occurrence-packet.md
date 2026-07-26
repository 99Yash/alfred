# ADR-0054 — Meeting prep: persisted per-occurrence packet (recompute-in-place) + calendar-watch-driven proactive trigger (horizon + sweep)


**Decision.** Meeting prep (MEET-001) is built as a fourth member of the briefing family, not a bespoke pipeline. A deterministic **gather** assembles one calendar event's context (attendees, recent Gmail threads, memory facts, overlapping todos); a **boss-tier compose** turns it into a short cited note; the result is **persisted** to a new `meeting_preps` table, **Replicache-synced read-only**, keyed per calendar occurrence. The packet is produced proactively by a **calendar push channel + a near-term sweep**, and on demand by a `system.prepare_meeting` tool — all three triggers converge on the same entry point. **Delivery** (the pre-meeting email, web augmentation at send) is explicitly deferred to MEET-002; this ADR is the **packet + its trigger**, not the surface it's delivered through.

Build sequence and file-level detail live in [docs/plans/meeting-prep-v1.md](../plans/meeting-prep-v1.md); glossary terms (*Meeting prep packet*, *`meeting_preps`*, *Gated recompute*, *Prep horizon + sweep*, *Calendar watch*, *`system.prepare_meeting`*, *Prep reference*) in [CONTEXT.md](../../CONTEXT.md). This ADR records the hard-to-reverse choices and the reasoning a future reader would otherwise ask "why?" about.

**Micro-decisions.**

1. **Mirror the briefing pipeline, don't invent one.** `gather → compose → store → sync` with the same shapes: a deterministic structured gather (audit/replay in a `gather` jsonb column), a single `meteredGenerateObject` compose emitting `[[<kind>:<id>]]` placeholders over an `availableReferences` list, a status-machine row, and a per-surface reference resolver. Meeting prep is the briefing's per-event sibling; reusing the pattern is cheaper to build and to reason about than a parallel design.

2. **`meeting_preps`, keyed `(user_id, event_key)`, upsert/recompute-in-place.** `event_key = ${credentialId}:${googleEventId}`. With `singleEvents=true` the Calendar read expands recurring series to per-occurrence instance ids, so one prep per occurrence falls out naturally. Re-running `prepareMeeting` overwrites `gather`/`note`, bumps `row_version`, updates `computed_at`. Cancelled/deleted occurrences mark the row `cancelled` (terminal, excluded from active sync) rather than pretending the compose failed or hard-deleting audit. **No version history** — drift-tracking is not a demo need and a versioned table adds a "which row is current" read concern. Schema + the `event_key` wire shape are the hard-to-reverse bits this ADR fixes.

3. **Gated recompute via `material_hash` (deterministic, no LLM).** Meetings mutate before they happen; most mutations (a time shift) don't change the prep's content. A `material_hash` over attendees + agenda/description + location + attachments is the discriminator: no row → full gather+compose; material change → recompute; **time-only shift → cheap path** (update `event_start`, skip compose); unchanged → no-op. This is what reconciles "boss-tier compose" with "minimise costs" — the lever is the **number** of composes (gated + horizon-bounded), not the model tier. The tier choice is deliberate: prep is a demo centerpiece where synthesis quality matters, and gating keeps the frequency low enough to afford boss-tier.

4. **Email threads from the ingested `documents` corpus, not live Gmail.** A deterministic scan over `documents (source='gmail')` within a recency window, matching attendee emails against `metadata.{from,to,cc}`, grouped by `source_thread_id`, citing the newest message as `email:<documentId>` — uniform with the briefing's citation kind. Chosen over live Gmail (no extra round trips/scope, citable, testable) and over semantic chunk search (the spec is "threads *involving attendees*," and the MEET-001 acceptance demands **deterministic** unit tests around attendee matching + source selection). `memory_chunks` vector recall is added as an **additive enrichment** for the memory-facts slot only, kept out of the deterministic units so the acceptance still holds for what it names.

5. **A parallel reference contract, not an extension of the briefing enum.** `MEETING_PREP_REFERENCE_KINDS = [meeting, email, todo]` + `resolveMeetingPrepReferences` in `@alfred/contracts`, mirroring the briefing resolver (relocated there per ADR-0049) but expanding against the *prep* gather. Briefing's tested enum/resolver stay untouched; each surface resolves against its own gather shape. Rejected: extending `BRIEFING_REFERENCE_KINDS` (pollutes it with a kind briefings never emit and couples one resolver to two gather shapes) and a generic shared resolver (largest refactor, touches the working briefing path — wrong risk profile for June). **Memory facts are not a citation kind** in v1 — they have no navigation target, so they're woven into prose with their ids retained in the gather for a future SEARCH-001 evidence layer.

6. **Proactive trigger = calendar push + near-term sweep, dispatched through `emitEvent`.** This is an application of [ADR-0024](#adr-0024) (change notifications) and [ADR-0047](#adr-0047) (event-trigger dispatch). The **surprising-without-context** part worth recording: Google Calendar push (`events.watch`) is **HTTPS-callback** based (not Pub/Sub like Gmail's `users.watch`), and pushes fire on **change, not on time passing** — an event booked weeks out pings once at creation and never again as it approaches. So neither a pure webhook nor "prep at scheduling" is sufficient: prep **compose** fires only for qualifying events entering a **48h horizon**, a push handles near-term changes immediately, and a **~20-min sweep** catches events that cross into the horizon without ever changing. The push handler `emitEvent`s `calendar.event_scheduled`; an event-triggered job calls `system.prepare_meeting`.

7. **No event mirror — `syncToken` cursor in `integration_credentials.metadata.calendarWatch`.** Mirrors the Gmail watch's `metadata.watch` convention (one watch per credential, v1 = `primary` calendar only). The push handler acts on the `events.list(syncToken)` delta live; the sweep does a bounded live `events.list(now, now+48h)`; the prep gather reads the event live and snapshots it into `gather`. Reuses the existing live calendar read path (consistent with how briefings read calendar today). A `documents`-backed calendar mirror (CAL-002) can land later without reworking this — chosen to keep the June surface small and dodge embeddings/reconciliation scope.

8. **`system.prepare_meeting` is the single convergence point.** A `system.*` tool (autonomy by default, riskTier `no_risk`), input `{ eventKey } | { timeMin, timeMax, attendeeHint? }`. The boss calls it on a chat request; the push job and the sweep call the same tool. **Event qualification** applies only to window-resolution (timed, `attendees ≥ 2`, not declined — skips focus blocks); an explicit `eventKey` is prepped unconditionally (explicit user intent wins). No internal-vs-external attendee filter in v1 (a MEET-002 prioritization concern).

**What this builds on.**

- **ADR-0041 / ADR-0049** — the gather/compose/store/sync pipeline and the contracts-resident reference resolver that meeting prep mirrors.
- **ADR-0024** — the change-notification posture; calendar watch is its second concrete application after Gmail.
- **ADR-0047** — the `emitEvent` bus the proactive trigger dispatches through.
- **ADR-0050** — `todos.sources` is the overlap key for the todo slot.
- **ADR-0053** — `system.prepare_meeting` rides the dispatch floor + autonomy posture like other system tools.

**Alternatives.**

- (a) **Cheap-tier (flash) compose**, matching triage. Rejected for v1: prep is the demo centerpiece where synthesis quality is the product, and gated-recompute + the 48h horizon already hold compose frequency low enough to afford boss-tier. Revisit if frequency or cost data says otherwise.
- (b) **Compute-on-demand, no table.** Rejected: no in-app surface, no delivery substrate for MEET-002, and recompute cost on every view. The synced packet is the artifact.
- (c) **Fold calendar-watch into a documents mirror (CAL-002) now.** Rejected for June scope: a second calendar read path + upsert/cancel reconciliation, more surface to get right. The cursor-only watch is the smaller correct step.
- (d) **Sweep-only (no push).** Workable and simplest, but loses the "prepped seconds after you book it" magic the webhook is for. Kept the push; the sweep is its safety net for the time-passing gap.

**Dependencies / deferred.**

- **Calendar push needs a domain-verified HTTPS callback** (GCP). No localhost in dev → tunnel for the push path, or test the sweep path locally. Plan Phases 0–2 (incl. the demoable `system.prepare_meeting` chat tool) carry **no** such dependency.
- **MEET-002** — delivery: pre-meeting email, web augmentation at send (`getWebSearchModel`), the in-app card (UI-001). The packet is reused; only near-send freshness/augmentation is new.
- **SEARCH-001** — promotes memory facts to a first-class cited `fact:` kind.
- **CAL-002 mirror**, **multi-calendar watch** — both deferred.

**Open (settle at build time from logs/testing, not now).**

- `selectThreads` recency window (start 90d), top-N caps (start 5/5/5), exact `material_hash` field set, horizon H (start 48h) + sweep cadence (start ~20m), `meeting_preps` sync prune window.
